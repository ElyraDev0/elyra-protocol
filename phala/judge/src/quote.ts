/*
 * Minimal reader for an Intel TDX v4 quote: 48-byte header, then the 584-byte TD report body.
 * Body offsets: TEE_TCB_SVN 0, MRSEAM 16, MRSIGNERSEAM 64, SEAMATTRIBUTES 112, TDATTRIBUTES 120, XFAM 128, MRTD 136,
 * MRCONFIGID 184, MROWNER 232, MROWNERCONFIG 280, RTMR0 328, RTMR1 376, RTMR2 424, RTMR3 472, REPORTDATA 520.
 * This only READS fields. Whether the quote is genuine (Intel signature, TCB status) is decided by the verifier
 * (dstack-verifier / dcap-qvl), never here.
 */
export type QuoteFields = { version: number; teeType: number; mrtd: string; rtmr: string[]; reportData: string };
const H = 48;
export function readQuote(hexQuote: string): QuoteFields {
  const q = Buffer.from(hexQuote.replace(/^0x/, ""), "hex");
  if (q.length < H + 584) throw new Error("quote too short");
  const version = q.readUInt16LE(0), teeType = q.readUInt32LE(4);
  if (version !== 4 || teeType !== 0x81) throw new Error(`not a TDX v4 quote (version ${version}, tee ${teeType.toString(16)})`);
  const at = (o: number, n: number) => q.subarray(H + o, H + o + n).toString("hex");
  return { version, teeType, mrtd: at(136, 48), rtmr: [at(328, 48), at(376, 48), at(424, 48), at(472, 48)], reportData: at(520, 64) };
}
