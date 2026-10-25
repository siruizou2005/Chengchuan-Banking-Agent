import type { Feature } from './workspace';

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

// Keep the supplied PNGs unchanged. Per-icon viewports normalize their transparent
// margins so the artwork has a consistent optical size within the home grid.
const featureArtwork = {
  accounts: { file: 'conponent1.png', viewBox: '130 110 1000 1000' },
  wealth: { file: 'conponent2.png', viewBox: '130 130 1000 1000' },
  transfer: { file: 'conponent3.png', viewBox: '185 220 900 900' },
  credit: { file: 'conponent4.png', viewBox: '80 110 1100 1100' },
  loan: { file: 'conponent5.png', viewBox: '90 110 1070 1070' },
  life: { file: 'conponent6.png', viewBox: '160 180 930 930' },
  channels: { file: 'conponent7.png', viewBox: '70 100 1100 1100' },
  services: { file: 'conponent8.png', viewBox: '200 230 850 850' },
} satisfies Record<Feature, { file: string; viewBox: string }>;

export function FeatureArtwork({ name, size = 34 }: { name: Feature; size?: number }) {
  const artwork = featureArtwork[name];
  return <svg width={size} height={size} viewBox={artwork.viewBox} aria-hidden="true" className="cc-feature-art" overflow="hidden">
    <image href={`/chengchuan/${artwork.file}`} width="1254" height="1254" />
  </svg>;
}
