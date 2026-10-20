// Also covers IDs ending in X and IDs adjacent to Chinese text (no word boundary). Digits touching a
// Latin letter are skipped: generated ids (prefix + hex UUID) sometimes contain 18 digits in a row, and
// masking them broke links to runs, actions and sessions.
export function redactIdentity(value) {
  if (typeof value === 'string') return value.replace(/(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g, number => '**************' + number.slice(-4));
  if (Array.isArray(value)) return value.map(redactIdentity);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(id_?number|id_?card|identity_?ciphertext|real_?name|biz_?token|biz_?token_?ciphertext)$/i.test(key))
    .map(([key, item]) => [key, redactIdentity(item)]));
  return value;
}
