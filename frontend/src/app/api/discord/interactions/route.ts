// Discord Interactions endpoint — the whole "bot" without a gateway process.
// Discord signs every request with the application's ed25519 key; anything that
// fails that check is rejected before parsing. /verify replies ephemerally with a
// one-time signed link to the wallet-verification page.

import { NextResponse } from "next/server";
import { ed25519 } from "@noble/curves/ed25519";
import { env, makeState } from "@/lib/discordVerify";

const SITE = "https://www.coattail.cash";

function verifyDiscordSignature(body: string, signature: string, timestamp: string): boolean {
  try {
    return ed25519.verify(signature, new TextEncoder().encode(timestamp + body), env.publicKey());
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const signature = request.headers.get("x-signature-ed25519") ?? "";
  const timestamp = request.headers.get("x-signature-timestamp") ?? "";
  const body = await request.text();
  if (!signature || !timestamp || !verifyDiscordSignature(body, signature, timestamp)) {
    return new NextResponse("invalid request signature", { status: 401 });
  }

  const interaction = JSON.parse(body);

  // PING — Discord's endpoint health check.
  if (interaction.type === 1) return NextResponse.json({ type: 1 });

  // /verify slash command, or a press of the persistent Verify button (type 3
  // component interaction) — both hand out the same one-time link.
  const isVerifyCommand = interaction.type === 2 && interaction.data?.name === "verify";
  const isVerifyButton = interaction.type === 3 && interaction.data?.custom_id === "coattail_verify";
  if (isVerifyCommand || isVerifyButton) {
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    const guildId = interaction.guild_id;
    if (!userId || !guildId) {
      return NextResponse.json({
        type: 4,
        data: { content: "run this inside the server, not in a DM.", flags: 64 },
      });
    }
    const state = makeState(userId, guildId);
    const link = `${SITE}/verify?state=${encodeURIComponent(state)}`;
    return NextResponse.json({
      type: 4,
      data: {
        flags: 64, // ephemeral — only the user sees their link
        content: [
          "**verify your broker** — the link is yours alone and expires in 15 minutes.",
          link,
          "",
          "you'll just paste your wallet address — nothing to connect, nothing to sign.",
          "if any site asks you to connect, approve or send anything during verification,",
          "it is not us — close it.",
        ].join("\n"),
      },
    });
  }

  return NextResponse.json({ type: 4, data: { content: "unknown command", flags: 64 } });
}
