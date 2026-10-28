// Original, unmodified user-supplied atlas. SVG viewports select only an icon;
// labels, status, focus, and click targets are independent HTML controls.
const crops = {
  appointments: '38 104 338 304', support: '398 105 324 304',
  services: '756 120 294 294', search: '1092 124 320 300',
  agent: '64 444 320 280', security: '412 440 314 284',
  messages: '752 436 310 294', personalization: '1110 442 302 284',
  channels: '180 755 330 300', feishu: '576 755 336 300', wechat: '954 755 350 300',
} as const;
export type ServiceAsset = keyof typeof crops;
export function ServiceArtwork({ name, size = 36, className = '' }: { name: ServiceAsset; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox={crops[name]} className={`cc-service-art ${className}`} aria-hidden="true" overflow="hidden"><image href="/chengchuan/service-icons.png" width="1448" height="1086" /></svg>;
}
export const hasServiceArtwork = (name: string): name is ServiceAsset => Object.hasOwn(crops, name);
