export const SCENE_TRANSFER_MIME = 'application/vnd.pixel-reconstruction.splat+gzip';

const MAGIC = 'PRSGZ001';
const HEADER_BYTES = 20;
const ROW_BYTES = 32;
const MAX_BYTES = 320 * 1024 * 1024;
const MAX_BLOCK_ROWS = 65536;
const abortError = () => new DOMException('场景解压已取消', 'AbortError');
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };

/** Decode transport bytes only. Legacy PLY/splat blobs retain their identity and MIME type. */
export async function unpackSceneTransfer(blob: Blob, signal?: AbortSignal): Promise<Blob> {
  checkAbort(signal);
  const header = new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer());
  checkAbort(signal);
  if (header.length < MAGIC.length || !Array.from(MAGIC).every((character, index) => header[index] === character.charCodeAt(0))) return blob;
  if (header.length !== HEADER_BYTES) throw new Error('场景压缩文件头不完整，请重新下载。');

  const fields = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const expected = fields.getUint32(8, true);
  const blockRows = fields.getUint32(12, true);
  const transform = fields.getUint32(16, true);
  if (!expected || expected % ROW_BYTES || expected > MAX_BYTES) throw new Error('场景原始长度无效或超过 320 MiB，请重新下载。');
  if (!blockRows || blockRows > MAX_BLOCK_ROWS) throw new Error('场景分块大小无效，请重新下载。');
  if (transform !== 1 && transform !== 2) throw new Error('场景压缩变换类型无效，请重新下载。');
  if (blob.size <= HEADER_BYTES) throw new Error('场景压缩数据缺失，请重新下载。');
  if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持场景解压，请更新浏览器后重试。');

  const reader = blob.slice(HEADER_BYTES).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const cancel = () => { void reader.cancel(abortError()).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const parts: Blob[] = [];
  let received = 0;
  let restored = 0;
  let filled = 0;
  let block = new Uint8Array(Math.min(blockRows * ROW_BYTES, expected));
  let decoded = new Uint8Array(block.length);
  let outputChunk = new Uint8Array(Math.min(MAX_BLOCK_ROWS * ROW_BYTES, expected));
  let chunkFilled = 0;
  let written = 0;
  let deadline = performance.now() + 10;
  let complete = false;

  const yieldIfNeeded = async () => {
    checkAbort(signal);
    if (performance.now() < deadline) return;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    checkAbort(signal);
    deadline = performance.now() + 10;
  };

  const restoreBlock = async () => {
    const rows = block.length / ROW_BYTES;
    for (let row = 0; row < rows; row++) {
      const offset = row * ROW_BYTES;
      for (let lane = 0; lane < ROW_BYTES; lane++) {
        const byte = block[lane * rows + row];
        decoded[offset + lane] = transform === 2 && row > 0 ? byte ^ decoded[offset - ROW_BYTES + lane] : byte;
      }
      if ((row & 255) === 255) await yieldIfNeeded();
    }
    await yieldIfNeeded();
    // Aggregate tiny protocol blocks, too: blockRows=1 must not create millions
    // of Blob objects. At most 160 completed 2 MiB parts cover the size limit.
    let copied = 0;
    while (copied < decoded.length) {
      const count = Math.min(decoded.length - copied, outputChunk.length - chunkFilled);
      outputChunk.set(decoded.subarray(copied, copied + count), chunkFilled);
      copied += count;
      chunkFilled += count;
      written += count;
      if (chunkFilled === outputChunk.length) {
        parts.push(new Blob([outputChunk]));
        outputChunk = new Uint8Array(Math.min(MAX_BLOCK_ROWS * ROW_BYTES, expected - written));
        chunkFilled = 0;
      }
    }
    restored += block.length;
    filled = 0;
    const nextLength = Math.min(blockRows * ROW_BYTES, expected - restored);
    if (block.length !== nextLength) {
      block = new Uint8Array(nextLength);
      decoded = new Uint8Array(nextLength);
    }
  };

  try {
    checkAbort(signal);
    while (true) {
      const { done, value } = await reader.read();
      checkAbort(signal);
      if (done) break;
      // Check before copying: an oversized gzip must never inflate into unbounded buffers.
      if (value.byteLength > expected - received) throw new Error('场景解压数据超过文件头长度，已停止加载。');
      received += value.byteLength;
      let offset = 0;
      while (offset < value.byteLength) {
        const count = Math.min(value.byteLength - offset, block.length - filled);
        block.set(value.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === block.length) await restoreBlock();
      }
      await yieldIfNeeded();
    }
    if (received !== expected || restored !== expected || filled) throw new Error('场景解压长度与文件头不一致，请重新下载。');
    checkAbort(signal);
    complete = true;
    return new Blob(parts, { type: 'application/octet-stream' });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (error instanceof Error && error.message.startsWith('场景')) throw error;
    // Native gzip decoding validates the compressed stream, CRC and size footer.
    throw new Error('场景压缩数据损坏或校验失败，请重新下载。');
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
