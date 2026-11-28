import crypto from 'node:crypto';
import fs from 'node:fs';

/** 整文件 SHA-256。流式读，避免把整首无损一次性读进内存。 */
export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
