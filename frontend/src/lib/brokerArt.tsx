// Deterministic local preview used while an on-chain bitmap read is unavailable.
// Its marginal trait counts mirror the canonical 1,776-token collection exactly.

const SLATE = "#4E5666";
const FACE = "#F5F2EB";
const INK = "#343945";

const SUPPLY = 1776;

function rank(tokenId: bigint, multiplier: number, offset: number) {
  return (Number((tokenId - 1n) % BigInt(SUPPLY)) * multiplier + offset) % SUPPLY;
}

function exactPick(tokenId: bigint, multiplier: number, offset: number, entries: readonly [string, number][]) {
  const value = rank(tokenId, multiplier, offset);
  let cursor = 0;
  for (const [name, count] of entries) {
    cursor += count;
    if (value < cursor) return name;
  }
  return "None";
}

export type Traits = {
  type: "Alien" | "Ape" | "Zombie" | "Female" | "Male";
  headwear: string;
  eyes: string;
  mouth: string;
  jewelry: string;
  face: string;
  accessory: string;
};

export function traitsOf(tokenId: bigint): Traits {
  const type = exactPick(tokenId, 5, 17, [
    ["Alien", 2], ["Ape", 4], ["Zombie", 16], ["Female", 681], ["Male", 1073],
  ]) as Traits["type"];
  const headwear = exactPick(tokenId, 7, 101, [
    ["Beanie", 8], ["Pilot Helmet", 10], ["Tiara", 10], ["Top Hat", 20],
    ["Cowboy Hat", 25], ["Hoodie", 46], ["Cap Forward", 45], ["Bandana", 85],
  ]);
  const eyes = exactPick(tokenId, 11, 211, [
    ["Welding Goggles", 15], ["3D Glasses", 51], ["VR", 59], ["Classic Shades", 89],
  ]);
  const mouth = exactPick(tokenId, 13, 307, [
    ["Buck Teeth", 14], ["Medical Mask", 31], ["Cigarette", 171],
    ["Smile", 42], ["Pipe", 56], ["Hot Lipstick", 124],
  ]);
  const jewelry = exactPick(tokenId, 17, 401, [
    ["Choker", 9], ["Silver Chain", 28], ["Gold Chain", 30], ["Earring", 437],
  ]);
  const face = exactPick(tokenId, 19, 503, [
    ["Spots", 22], ["Rosy Cheeks", 23], ["Clown Nose", 38], ["Mole", 114],
  ]);
  const accessory = exactPick(tokenId, 23, 607, [
    ["Headphones", 240], ["Earbuds", 140], ["Hair Clip", 100], ["Small Nose Ring", 100],
    ["Headband", 110], ["Laurel Wreath", 60], ["Flower Behind Ear", 90], ["Cheek Bandage", 100],
    ["Eyepatch", 120], ["Round Glasses", 120], ["Aviator Shades", 120], ["Neck Scarf", 100],
    ["Neck Kerchief", 80], ["Pendant", 110], ["Septum Ring", 70],
  ]);
  return { type, headwear, eyes, mouth, jewelry, face, accessory };
}

export function BrokerAvatar({ tokenId, size = 96 }: { tokenId: bigint; size?: number }) {
  const t = traitsOf(tokenId);
  const alien = t.type === "Alien";
  const ape = t.type === "Ape";
  const zombie = t.type === "Zombie";
  const faceFill = zombie ? "#D8DDD1" : FACE;

  return (
    <svg width={size} height={size} viewBox="0 0 20 22" shapeRendering="crispEdges" role="img" aria-label={`Broker #${tokenId}`}>
      <rect width="20" height="22" fill="#EDE8DE" />
      <rect x="3" y="18" width="14" height="4" fill={SLATE} />
      {ape && <><rect x="3" y="7" width="2" height="4" fill={INK} /><rect x="15" y="7" width="2" height="4" fill={INK} /></>}
      <rect x={alien ? 4 : 5} y={alien ? 3 : 4} width={alien ? 12 : 10} height={alien ? 14 : 13} fill={INK} />
      <rect x={alien ? 5 : 6} y={alien ? 4 : 5} width={alien ? 10 : 8} height={alien ? 12 : 11} fill={faceFill} />
      {!alien && !ape && <><rect x="6" y="4" width="8" height="2" fill={INK} /><rect x="5" y="6" width="2" height="2" fill={INK} /></>}
      {t.headwear !== "None" && <rect x="5" y="2" width="10" height="2" fill={SLATE} />}
      {t.accessory === "Headphones" && <><rect x="4" y="7" width="2" height="6" fill={INK} /><rect x="14" y="7" width="2" height="6" fill={INK} /><rect x="5" y="4" width="10" height="1" fill={INK} /></>}
      {t.accessory === "Earbuds" && <><rect x="5" y="11" width="1" height="2" fill={SLATE} /><rect x="14" y="11" width="1" height="2" fill={SLATE} /></>}
      {(t.accessory === "Round Glasses" || t.accessory === "Aviator Shades") && <><rect x="6" y="8" width="3" height="2" fill={INK} /><rect x="11" y="8" width="3" height="2" fill={INK} /></>}
      {t.accessory === "Eyepatch" && <rect x="6" y="8" width="4" height="2" fill={INK} />}
      {t.eyes === "VR" || t.eyes === "Classic Shades" ? (
        <rect x="6" y="8" width="8" height="2" fill={INK} />
      ) : t.eyes === "Welding Goggles" || t.eyes === "3D Glasses" ? (
        <><rect x="6" y="8" width="3" height="2" fill={INK} /><rect x="11" y="8" width="3" height="2" fill={INK} /></>
      ) : (
        <><rect x="7" y="8" width="2" height={alien ? 2 : 1} fill={SLATE} /><rect x="11" y="8" width="2" height={alien ? 2 : 1} fill={SLATE} /></>
      )}
      {t.face === "Clown Nose" ? <rect x="9" y="11" width="2" height="2" fill={SLATE} /> : <rect x="9" y="11" width="2" height="1" fill={SLATE} />}
      {t.accessory === "Small Nose Ring" && <rect x="10" y="12" width="1" height="1" fill={INK} />}
      <rect x={t.mouth === "Smile" ? 8 : 9} y="14" width={t.mouth === "Smile" ? 4 : 2} height="1" fill={SLATE} />
      {(t.mouth === "Cigarette" || t.mouth === "Pipe") && <rect x="11" y="14" width="4" height="1" fill={INK} />}
      {t.jewelry === "Earring" && <rect x="15" y="11" width="1" height="2" fill={SLATE} />}
    </svg>
  );
}
