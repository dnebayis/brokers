#!/usr/bin/env python3
"""Production batch generator using Replicate's prediction API.

This avoids `replicate.run()`'s opaque wait loop and makes long batches resumable:
completed `{tokenId}.bin` + `{tokenId}.traits` pairs are skipped on rerun.
"""

import argparse
import json
import os
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional

import requests

from binarize import binarize_image
from config import (
    DEFAULT_FLUX_MODEL,
    FLUX_MODEL_PARAMS,
    FLUX_MODELS,
    FLUX_PARAMS,
)
from output import load_existing_traits, save_token
from quality import inspect_bitmap
from trait_names import RARE_TYPES, apply_legendary_overrides, build_prompt, label, legendary_prompt
from traits import hex_to_traits, traits_for_token_id, traits_to_hex


LOG_LOCK = threading.Lock()
PREDICTION_SLOTS = threading.BoundedSemaphore(3)


def load_env() -> None:
    env_path = Path(__file__).with_name(".env")
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        # The pipeline-local file is explicit project configuration. Prefer it
        # over a stale token inherited from an interactive parent process.
        os.environ[key.strip()] = value.strip().strip('"').strip("'")


def log_event(output_dir: str, event: dict) -> None:
    event = {"ts": time.time(), **event}
    with LOG_LOCK:
        with open(os.path.join(output_dir, "generation-manifest.jsonl"), "a") as f:
            f.write(json.dumps(event, sort_keys=True) + "\n")


def request_with_retry(
    method: str,
    url: str,
    headers: dict,
    *,
    timeout: int,
    retries: int,
    **kwargs,
) -> requests.Response:
    last_error: Optional[Exception] = None
    for attempt in range(1, retries + 1):
        try:
            response = requests.request(
                method,
                url,
                headers=headers,
                timeout=timeout,
                **kwargs,
            )
            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After", "")
                try:
                    wait_seconds = float(retry_after)
                except ValueError:
                    wait_seconds = 0
                # Respect an explicit server cooldown. Without one, use jittered
                # exponential backoff so parallel workers do not all wake and
                # retry in the same instant (the previous fixed 30s wait caused
                # a thundering herd and reduced throughput to one image/30s).
                fallback = min(20.0, (2 ** min(attempt, 4)) + random.uniform(0.5, 3.0))
                wait_seconds = min(60.0, max(wait_seconds, fallback))
                last_error = RuntimeError(
                    f"Replicate rate limited the request; retrying in {wait_seconds:g}s"
                )
                if attempt < retries:
                    time.sleep(wait_seconds)
                    continue
            response.raise_for_status()
            return response
        except Exception as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(min(2 ** attempt, 12))
    raise RuntimeError(f"{method} {url} failed after {retries} attempts: {last_error}")


def traits_for_token(token_id: int, output_dir: str, existing: set[bytes], seed_salt: int) -> bytes:
    expected = apply_legendary_overrides(token_id, traits_for_token_id(token_id, seed_salt))
    traits_path = os.path.join(output_dir, f"{token_id}.traits")
    if os.path.exists(traits_path):
        traits = hex_to_traits(Path(traits_path).read_text().strip())
        if traits != expected:
            raise RuntimeError(
                f"Token {token_id} has a legacy/incompatible trait assignment in {traits_path}; "
                "use a fresh output directory so old art cannot be paired with the new schema"
            )
        return traits
    existing.add(expected)
    return expected


def create_prediction(prompt: str, model_key: str, headers: dict, retries: int) -> dict:
    owner, model = FLUX_MODELS[model_key].split("/")
    url = f"https://api.replicate.com/v1/models/{owner}/{model}/predictions"
    body = {
        "input": {
            "prompt": prompt,
            **FLUX_PARAMS,
            **FLUX_MODEL_PARAMS.get(model_key, {}),
        }
    }
    return request_with_retry(
        "POST",
        url,
        headers,
        json=body,
        timeout=45,
        retries=retries,
    ).json()


def poll_prediction(
    prediction: dict,
    headers: dict,
    *,
    poll_interval: int,
    max_wait: int,
    retries: int,
) -> dict:
    deadline = time.time() + max_wait
    while time.time() < deadline:
        time.sleep(poll_interval)
        prediction = request_with_retry(
            "GET",
            prediction["urls"]["get"],
            headers,
            timeout=35,
            retries=retries,
        ).json()
        status = prediction.get("status")
        if status in {"succeeded", "failed", "canceled"}:
            return prediction
    cancel_url = prediction.get("urls", {}).get("cancel")
    if cancel_url:
        try:
            request_with_retry(
                "POST",
                cancel_url,
                headers,
                timeout=30,
                retries=2,
            )
        except Exception:
            pass
    raise TimeoutError(f"Prediction {prediction.get('id')} did not finish in {max_wait}s")


def download_image(image_url: str, headers: dict, retries: int) -> bytes:
    # Replicate delivery URLs do not require auth, but the header is harmless.
    return request_with_retry(
        "GET",
        image_url,
        headers,
        timeout=90,
        retries=retries,
    ).content


def generate_one(
    token_id: int,
    traits: bytes,
    args: argparse.Namespace,
    headers: dict,
) -> tuple[int, bool, str]:
    bitmap_path = os.path.join(args.output, f"{token_id}.bin")
    traits_path = os.path.join(args.output, f"{token_id}.traits")
    review_source = Path(args.output, f"{token_id}.review.src.png")
    review_bitmap = Path(args.output, f"{token_id}.review.bin")
    review_traits = Path(args.output, f"{token_id}.review.traits")
    token_type = label("Type", traits[0])
    if token_type in RARE_TYPES and all(path.exists() for path in (review_source, review_bitmap, review_traits)):
        if hex_to_traits(review_traits.read_text().strip()) != traits:
            return token_id, False, "review traits do not match exact collection plan"
        reviewed_bitmap = review_bitmap.read_bytes()
        reviewed_quality = inspect_bitmap(reviewed_bitmap)
        if not reviewed_quality.accepted:
            return token_id, False, "review bitmap no longer passes quality"
        if not args.accept_rare_type:
            return token_id, False, f"manual {token_type} review pending"
        Path(args.output, f"{token_id}.src.png").write_bytes(review_source.read_bytes())
        save_token(args.output, token_id, reviewed_bitmap, traits)
        log_event(args.output, {"event": "rare_type_review_approved", "token_id": token_id, "type": token_type})
        return token_id, True, "approved reviewed rare type"
    quality_hint = ""
    if os.path.exists(bitmap_path) and os.path.exists(traits_path):
        current_quality = inspect_bitmap(Path(bitmap_path).read_bytes())
        density_ok = not args.max_foreground or current_quality.foreground_pixels <= args.max_foreground
        if current_quality.accepted and density_ok:
            return token_id, True, "skipped"
        reason = current_quality.reason if not current_quality.accepted else "density_target_exceeded"
        quality_hint = quality_prompt_hint(reason)

    base_prompt = legendary_prompt(token_id) or build_prompt(traits)
    if args.prompt_suffix:
        base_prompt += ", " + args.prompt_suffix.strip().lstrip(", ")
    for attempt in range(1, args.prediction_retries + 1):
        try:
            prompt = base_prompt + quality_hint
            # Replicate accepts only a small number of concurrent predictions for
            # this account/model. Keep 20 local workers for file/quality work, but
            # bound active remote predictions so excess workers wait locally
            # instead of burning their retry budgets on 429 responses.
            with PREDICTION_SLOTS:
                prediction = create_prediction(prompt, args.model, headers, args.http_retries)
                log_event(
                    args.output,
                    {
                        "event": "prediction_created",
                        "token_id": token_id,
                        "attempt": attempt,
                        "model": args.model,
                        "prediction_id": prediction.get("id"),
                        "traits": traits_to_hex(traits),
                        "type": label("Type", traits[0]),
                        "legendary": bool(legendary_prompt(token_id)),
                        "prompt": prompt,
                    },
                )
                prediction = poll_prediction(
                    prediction,
                    headers,
                    poll_interval=args.poll_interval,
                    max_wait=args.max_wait,
                    retries=args.http_retries,
                )
            if prediction.get("status") != "succeeded":
                log_event(
                    args.output,
                    {
                        "event": "prediction_failed",
                        "token_id": token_id,
                        "attempt": attempt,
                        "prediction_id": prediction.get("id"),
                        "error": prediction.get("error") or prediction.get("status"),
                    },
                )
                continue

            output = prediction.get("output")
            image_url = output[0] if isinstance(output, list) else output
            image_bytes = download_image(image_url, headers, args.http_retries)
            Path(args.output, f"{token_id}.attempt-{attempt}.src.png").write_bytes(image_bytes)
            bitmap = binarize_image(image_bytes, args.threshold, token_id, args.pixel_style)
            quality = inspect_bitmap(bitmap)
            used_pfp_crop = 0.0
            if quality.reason == "body_too_large":
                for crop_ratio in (0.82, 0.78, 0.70):
                    cropped_bitmap = binarize_image(
                        image_bytes,
                        args.threshold,
                        token_id,
                        args.pixel_style,
                        pfp_crop=True,
                        pfp_crop_ratio=crop_ratio,
                    )
                    cropped_quality = inspect_bitmap(cropped_bitmap)
                    if cropped_quality.accepted:
                        bitmap = cropped_bitmap
                        quality = cropped_quality
                        used_pfp_crop = crop_ratio
                        break
            density_ok = not args.max_foreground or quality.foreground_pixels <= args.max_foreground
            if not quality.accepted or not density_ok:
                reason = quality.reason if not quality.accepted else "density_target_exceeded"
                quality_hint = quality_prompt_hint(reason)
                log_event(
                    args.output,
                    {
                        "event": "quality_rejected",
                        "token_id": token_id,
                        "attempt": attempt,
                        "prediction_id": prediction.get("id"),
                        "reason": reason,
                        "foreground_pixels": quality.foreground_pixels,
                        "interior_detail_pixels": quality.interior_detail_pixels,
                    },
                )
                continue
            if token_type in RARE_TYPES and not args.accept_rare_type:
                review_source.write_bytes(image_bytes)
                review_bitmap.write_bytes(bitmap)
                review_traits.write_text(traits_to_hex(traits) + "\n")
                log_event(
                    args.output,
                    {
                        "event": "rare_type_review_required",
                        "token_id": token_id,
                        "type": token_type,
                        "prediction_id": prediction.get("id"),
                    },
                )
                return token_id, False, f"manual {token_type} review required"
            Path(args.output, f"{token_id}.src.png").write_bytes(image_bytes)
            save_token(args.output, token_id, bitmap, traits)
            pixel_count = quality.foreground_pixels
            log_event(
                args.output,
                {
                    "event": "token_saved",
                    "token_id": token_id,
                    "attempt": attempt,
                    "prediction_id": prediction.get("id"),
                    "traits": traits_to_hex(traits),
                    "foreground_pixels": pixel_count,
                    "pfp_crop_ratio": used_pfp_crop,
                },
            )
            return token_id, True, f"saved {pixel_count}/1600"
        except Exception as exc:
            log_event(
                args.output,
                {
                    "event": "token_error",
                    "token_id": token_id,
                    "attempt": attempt,
                    "error": str(exc),
                },
            )
            if attempt < args.prediction_retries:
                time.sleep(min(2 ** attempt, 20))

    return token_id, False, "failed"


def quality_prompt_hint(reason: str) -> str:
    if reason == "top_margin_missing":
        return (
            ", composition correction: keep the complete head hair natural ears and headwear comfortably inside frame, "
            "add generous pure white space above the highest point, do not squash stretch or flatten the character"
        )
    if reason == "body_too_large":
        return (
            ", composition correction: move the camera naturally closer to the face, crop near the collarbones, "
            "show only the neck and tiny top corners of the shoulders, no torso, preserve natural head proportions"
        )
    if reason == "density_target_exceeded":
        return (
            ", density correction only: preserve the exact shoulder width body size framing and silhouette, "
            "reduce dark pixel density by replacing solid dark interior fills with clean white negative space, "
            "keep the face eyes nose mouth glasses and jaw clearly separated, no narrowing, no shrinking"
        )
    if reason in {"foreground_too_dense", "insufficient_internal_detail"}:
        return (
            ", quality correction: use much less black ink, mostly pure white canvas, "
            "clear white negative space inside the hood and face, visible eyes mouth and face contours, "
            "clean separated facial details with smooth continuous edges, "
            "narrow shoulders, thin outer contour, unfilled clothing, no large solid black areas"
        )
    if reason == "foreground_too_sparse":
        return (
            ", quality correction: make the face larger within the existing safe headroom, "
            "use thicker smooth connected facial shapes without adding more torso"
        )
    return ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a resumable Replicate art batch")
    parser.add_argument("--count", type=int, default=0)
    parser.add_argument("--output", required=True)
    parser.add_argument("--start-id", type=int, default=1)
    parser.add_argument("--token-ids-file", help="Optional newline-separated token IDs; overrides count/start-id")
    parser.add_argument("--existing-traits-dir", action="append", default=[], help="Include another collection directory in trait uniqueness checks")
    parser.add_argument("--model", choices=sorted(FLUX_MODELS.keys()), default=DEFAULT_FLUX_MODEL)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument(
        "--api-concurrency",
        type=int,
        default=3,
        help="Maximum active Replicate predictions; local workers above this wait without sending 429-prone POSTs",
    )
    parser.add_argument("--seed-salt", type=int, default=0)
    parser.add_argument(
        "--prompt-suffix",
        default="",
        help="Optional art-direction suffix for an isolated iteration; traits remain unchanged",
    )
    parser.add_argument(
        "--max-foreground",
        type=int,
        default=0,
        help="Optional per-run dark-pixel ceiling for art iteration; zero keeps the collection gate",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        choices=range(1, 256),
        default=128,
        metavar="1..255",
        help="Per-run binarization threshold; collection default remains 128",
    )
    parser.add_argument(
        "--pixel-style",
        choices=("scatter", "contour"),
        default="contour",
        help="contour preserves compact shape islands (collection default); scatter is experimental",
    )
    parser.add_argument("--poll-interval", type=int, default=5)
    parser.add_argument("--max-wait", type=int, default=480)
    parser.add_argument("--prediction-retries", type=int, default=3)
    parser.add_argument(
        "--accept-rare-type",
        action="store_true",
        help="Promote an already generated *.review source after explicit visual Type review",
    )
    parser.add_argument("--http-retries", type=int, default=4)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.token_ids_file and args.count < 1:
        raise SystemExit("--count must be at least 1 when --token-ids-file is not used")
    if args.workers < 1:
        raise SystemExit("--workers must be at least 1")
    if args.api_concurrency < 1 or args.api_concurrency > args.workers:
        raise SystemExit("--api-concurrency must be between 1 and --workers")

    global PREDICTION_SLOTS
    PREDICTION_SLOTS = threading.BoundedSemaphore(args.api_concurrency)

    load_env()
    api_token = os.environ.get("REPLICATE_API_TOKEN")
    if not api_token:
        raise SystemExit("REPLICATE_API_TOKEN not set")

    os.makedirs(args.output, exist_ok=True)
    headers = {
        "Authorization": f"Token {api_token}",
        "Content-Type": "application/json",
    }

    existing = load_existing_traits(args.output)
    for existing_dir in args.existing_traits_dir:
        existing.update(load_existing_traits(existing_dir))
    if args.token_ids_file:
        token_ids = [int(line.strip()) for line in Path(args.token_ids_file).read_text().splitlines() if line.strip()]
    else:
        token_ids = list(range(args.start_id, args.start_id + args.count))
    traits_by_id: dict[int, bytes] = {}
    for token_id in token_ids:
        traits_by_id[token_id] = traits_for_token(token_id, args.output, existing, args.seed_salt)

    print(
        f"Generating {len(token_ids)} tokens to {os.path.abspath(args.output)} "
        f"with {args.model} ({FLUX_MODELS[args.model]}), workers={args.workers}, "
        f"api_concurrency={args.api_concurrency}"
    )

    ok = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(generate_one, token_id, traits_by_id[token_id], args, headers): token_id
            for token_id in token_ids
        }
        for future in as_completed(futures):
            token_id, success, message = future.result()
            if success:
                ok += 1
            else:
                failed += 1
            print(f"#{token_id}: {message} (ok={ok}, failed={failed})", flush=True)

    print(f"Done. Success={ok}, failed={failed}, output={os.path.abspath(args.output)}")


if __name__ == "__main__":
    main()
