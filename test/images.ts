// Minimal image headers for dimension tests: just enough bytes to parse.

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number) => [...le16(n & 0xffff), ...le16(n >>> 16)];
const be32 = (n: number) => le32(n).toReversed();

export function png(width: number, height: number): Uint8Array {
	return new Uint8Array([
		0x89,
		...ascii("PNG\r\n\x1a\n"),
		...be32(13),
		...ascii("IHDR"),
		...be32(width),
		...be32(height),
		8,
		6,
		0,
		0,
		0,
	]);
}

export function gif(width: number, height: number): Uint8Array {
	return new Uint8Array([
		...ascii("GIF89a"),
		...le16(width),
		...le16(height),
		0,
		0,
		0,
	]);
}

export function ico(...entries: [number, number][]): Uint8Array {
	return new Uint8Array([
		0,
		0,
		1,
		0,
		...le16(entries.length),
		...entries.flatMap(([w, h]) =>
			[w, h].concat(Array.from({ length: 14 }, () => 0)),
		),
	]);
}

const riff = (chunk: string, payload: number[]) =>
	new Uint8Array([
		...ascii("RIFF"),
		...le32(4 + 8 + payload.length),
		...ascii("WEBP"),
		...ascii(chunk),
		...le32(payload.length),
		...payload,
	]);

export function webpExtended(width: number, height: number): Uint8Array {
	return riff("VP8X", [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);
}

export function webpLossless(width: number, height: number): Uint8Array {
	return riff("VP8L", [0x2f, ...le32((width - 1) | ((height - 1) << 14))]);
}

export function webpLossy(width: number, height: number): Uint8Array {
	return riff("VP8 ", [
		0,
		0,
		0,
		0x9d,
		0x01,
		0x2a,
		...le16(width),
		...le16(height),
	]);
}
