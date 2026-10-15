// Also covers IDs ending in X and IDs adjacent to Chinese text (no word boundary).
export function redactIdentity(value) {
  if (typeof value === 'string') return value.replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, number => '**************' + number.slice(-4));
  if (Array.isArray(value)) return value.map(redactIdentity);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(id_?number|id_?card|identity_?ciphertext|real_?name|biz_?token|biz_?token_?ciphertext)$/i.test(key))
    .map(([key, item]) => [key, redactIdentity(item)]));
  return value;
}
