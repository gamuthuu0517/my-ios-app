// mp4 / mov の中身（moov ボックス）を読んで、映像の平均フレームレートを調べる

async function readBytes(blob: Blob, start: number, len: number): Promise<DataView> {
  return new DataView(await blob.slice(start, start + len).arrayBuffer());
}

function type(dv: DataView, off: number): string {
  return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
}

/** 子ボックスを順に返す */
function* boxes(dv: DataView, start: number, end: number): Generator<{ type: string; start: number; end: number }> {
  let off = start;
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    const t = type(dv, off + 4);
    let header = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) size = end - off;
    if (size < header) return;
    yield { type: t, start: off + header, end: Math.min(end, off + size) };
    off += size;
  }
}

function find(dv: DataView, start: number, end: number, name: string) {
  for (const b of boxes(dv, start, end)) if (b.type === name) return b;
  return null;
}

/** 平均フレームレート。読めなければ null */
export async function detectFps(blob: Blob): Promise<number | null> {
  try {
    // 最上位のボックスをたどって moov を探す（ファイル末尾にあることも多い）
    let off = 0;
    let moov: DataView | null = null;
    while (off + 8 <= blob.size) {
      const hdr = await readBytes(blob, off, 16);
      let size = hdr.getUint32(0);
      const t = type(hdr, 4);
      if (size === 1) size = Number(hdr.getBigUint64(8));
      else if (size === 0) size = blob.size - off;
      if (size < 8) return null;
      if (t === 'moov') {
        moov = await readBytes(blob, off, size);
        break;
      }
      off += size;
    }
    if (!moov) return null;

    for (const trak of boxes(moov, 8, moov.byteLength)) {
      if (trak.type !== 'trak') continue;
      const mdia = find(moov, trak.start, trak.end, 'mdia');
      if (!mdia) continue;
      const hdlr = find(moov, mdia.start, mdia.end, 'hdlr');
      if (!hdlr || type(moov, hdlr.start + 8) !== 'vide') continue;
      const mdhd = find(moov, mdia.start, mdia.end, 'mdhd');
      if (!mdhd) continue;
      const v1 = moov.getUint8(mdhd.start) === 1;
      const timescale = moov.getUint32(mdhd.start + (v1 ? 20 : 12));
      const duration = v1 ? Number(moov.getBigUint64(mdhd.start + 24)) : moov.getUint32(mdhd.start + 16);
      const minf = find(moov, mdia.start, mdia.end, 'minf');
      const stbl = minf && find(moov, minf.start, minf.end, 'stbl');
      const stsz = stbl && find(moov, stbl.start, stbl.end, 'stsz');
      if (!stsz || !timescale || !duration) continue;
      const count = moov.getUint32(stsz.start + 8);
      const fps = count / (duration / timescale);
      return fps > 0 && fps < 1000 ? fps : null;
    }
    return null;
  } catch {
    return null;
  }
}
