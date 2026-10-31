// Center-crops to a square JPEG small enough for the server's limit, so large phone photos upload quickly.
export async function compressAvatar(file: File, size = 256): Promise<string> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('无法读取这张图片，请换一张 JPG 或 PNG 图片'); }
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
  const side = Math.min(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, size, size);
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.82);
}
