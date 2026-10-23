import { AgentMark } from './AgentMark';
import { useTheme, type Theme } from './Theme';

/** Small matching line icons. Decorative only: labels carry the business meaning. */
export function ThemeGlyph({ theme, size = 22 }: { theme?: Theme; size?: number }) {
  const inherited = useTheme(), kind = theme ?? inherited;
  if (kind === 'assistant') return <AgentMark size={size} />;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="theme-glyph">
    {kind === 'wealth' ? <><path d="M12 20V11M12 14C5 15 3 10 4 6c5 0 8 3 8 8ZM12 10c0-5 4-8 8-7 1 5-2 8-8 7ZM6 21h12" /><path d="m12 14-4-4m4 0 4-4" /></>
      : kind === 'life' ? <><path d="M7 15h10l-1 6H8l-1-6ZM12 15V8M12 12C7 12 5 8 6 5c4 0 6 3 6 7ZM12 10c0-4 3-6 6-6 0 4-2 6-6 6Z" /><path d="M20 2v2m1 3h1" /></>
      : kind === 'profile' ? <><path d="M20.5 12c0 5-3.4 9-8.5 9S3 17 3 12s4-9 9-9 8.5 4 8.5 9Z" /><path d="M17 12c0 3-2 5.5-5 5.5s-5.5-2.4-5.5-5.5S9 6 12 6s5 3 5 6Z" /><path d="M14.2 12c0 1.5-1 2.7-2.4 2.7S9.5 13.5 9.5 12s1-2.7 2.3-2.7 2.4 1.2 2.4 2.7Z" /></>
      : <><path d="M7 21 17 4M8 18c-6-1-6-5-3-6-4-2-2-6 2-5-1-5 4-6 6-2 3-4 7-1 5 3 5 1 5 5 0 6 2 4-2 7-6 4" /><path d="m11 14-5-3m8-2 3-1" /></>}
  </svg>;
}

// All scenes share the same ink, sage and warm paper palette. No chart-like paths.
const leaf = 'M0 0C-22-3-30-23-24-39C-7-36 6-20 0 0Z';
function Leaf({ x, y, angle = 0, scale = 1, tone = '#8fa382' }: { x: number; y: number; angle?: number; scale?: number; tone?: string }) {
  return <g transform={`translate(${x} ${y}) rotate(${angle}) scale(${scale})`}><path d={leaf} fill={tone} /><path d="M0 0-20-32M-9-13l-10-2M-14-23l1-8" fill="none" stroke="#416c53" strokeWidth="1" opacity=".6" /></g>;
}

/** Original vector illustrations, not financial or status visualizations. */
export function BotanicalArt({ theme, className = '' }: { theme?: Theme; className?: string }) {
  const inherited = useTheme(), kind = theme ?? inherited;
  return <svg viewBox={kind === 'profile' ? '25 10 180 170' : '0 0 220 180'} width="220" height="180" fill="none" aria-hidden="true" focusable="false" className={`botanical-art botanical-${kind} ${className}`}>
    {kind === 'wealth' && <>
      <circle cx="119" cy="81" r="67" fill="#e3e9d8" /><circle cx="165" cy="37" r="15" fill="#e8d9ad" />
      <ellipse cx="112" cy="162" rx="67" ry="7" fill="#d5ddc9" />
      <path d="M109 160C102 118 120 72 106 25M111 129c-22-12-37-25-47-42M111 99c22-12 37-30 46-51" stroke="#647f58" strokeWidth="2.5" strokeLinecap="round" />
      <Leaf x={109} y={74} angle={-12} scale={1.15} /><Leaf x={112} y={101} angle={100} scale={1.2} tone="#648460" />
      <Leaf x={107} y={123} angle={-30} scale={1.15} tone="#a2b28d" /><Leaf x={111} y={149} angle={102} scale={1.05} tone="#8fa382" />
      <Leaf x={106} y={43} angle={52} scale={.8} tone="#b5c39d" /><Leaf x={71} y={100} angle={-24} scale={.7} />
      <Leaf x={143} y={73} angle={95} scale={.72} tone="#a2b28d" />
      <path d="M52 157c-2-10-1-20 4-27m-4 22c-9-2-13-8-11-13 7 1 11 6 11 13" stroke="#a1ac8b" strokeWidth="1.5" />
      <path d="M144 158h35M41 165h16" stroke="#b4bea4" strokeWidth="1.5" strokeLinecap="round" />
    </>}
    {kind === 'assistant' && <>
      <ellipse cx="110" cy="90" rx="86" ry="65" fill="#eee8dc" />
      <path d="M110 93C74 95 77 49 40 40M111 93c24-1 36-41 71-47M110 93c-25 1-26 43-69 50M110 93c27 2 40 43 69 49" stroke="#b0987d" strokeWidth="1.6" />
      <path d="M44 40c4 15 17 20 25 19-1-15-11-23-25-19ZM179 46c-15-2-26 5-28 18 15 2 25-4 28-18ZM42 143c15 3 29-4 31-17-15-3-28 4-31 17ZM179 143c-1-16-13-22-25-21 1 15 13 24 25 21Z" fill="#b5c2a6" />
      <path d="m46 42 18 14m111-7-18 12M47 140l21-11m106 10-15-13" stroke="#748b6d" strokeWidth="1.2" />
      <path d="M73 60c-9 19-13 36-9 54M151 66c7 17 8 34 4 49" stroke="#a5b7bf" strokeWidth="1.2" strokeDasharray="3 5" />
      {[ [39,39], [183,45], [40,144], [181,145], [63,91], [158,92] ].map(([cx,cy], i) => <circle key={i} cx={cx} cy={cy} r={i < 4 ? 4 : 3} fill={i < 4 ? '#a47551' : '#8ca8b8'} stroke="#fffcf8" strokeWidth="2" />)}
      <circle cx="110" cy="91" r="35" fill="#fffcf8" stroke="#d8cbb9" /><circle cx="110" cy="91" r="42" stroke="#d8cbb9" strokeDasharray="2 6" />
    </>}
    {kind === 'life' && <>
      <path d="M40 154V66a62 62 0 0 1 124 0v88" fill="#f5eee0" stroke="#dacbb6" strokeWidth="2" />
      <circle cx="133" cy="49" r="24" fill="#e7c891" /><path d="M40 92h124M101 5v149" stroke="#e2d5c2" strokeWidth="2" />
      <path d="m150 83 51 67h-44l-32-51" fill="#ead7b8" opacity=".65" />
      <ellipse cx="111" cy="162" rx="82" ry="7" fill="#ddcbb5" />
      <path d="M83 124h46l-5 35H88l-5-35Z" fill="#bc8c72" /><path d="M79 120h54v9H79z" fill="#c79a80" />
      <path d="M106 122c-2-23 4-53-1-74m1 51c17-9 23-20 25-35m-25 52c-19-4-27-16-30-27" stroke="#6e8561" strokeWidth="2.2" />
      <Leaf x={106} y={77} angle={-8} scale={.85} /><Leaf x={107} y={104} angle={105} scale={1} tone="#708b68" />
      <Leaf x={107} y={121} angle={-28} scale={.85} tone="#a4b28d" /><Leaf x={127} y={78} angle={95} scale={.7} />
      <path d="M152 144h24v16h-24z" fill="#fffcf8" /><path d="M176 147h4a5 5 0 0 1 0 10h-4" stroke="#fffcf8" strokeWidth="3" />
      <path d="M31 164h168" stroke="#b99d80" strokeWidth="2" strokeLinecap="round" />
    </>}
    {kind === 'profile' && <>
      <path d="M178 89c0 43-29 75-70 75S35 138 35 95 64 19 109 19s69 26 69 70Z" fill="#e7d9c7" />
      <path d="M166 90c0 37-24 61-58 61S48 130 48 95s24-63 61-63 57 22 57 58Z" stroke="#b89d7e" strokeWidth="1.5" />
      <path d="M154 91c0 29-19 48-46 48s-47-18-47-44 20-50 48-50 45 18 45 46Z" stroke="#c0a88d" strokeWidth="1.5" />
      <path d="M141 92c0 21-13 34-33 34S75 113 75 94s14-36 34-36 32 14 32 34Z" stroke="#b89d7e" strokeWidth="1.5" />
      <path d="M129 93c0 13-8 21-21 21s-21-8-21-20 9-22 22-22 20 9 20 21Z" stroke="#a68b6e" strokeWidth="1.5" />
      <path d="M109 85c10-1 12 15 0 17-10 0-11-15 0-17Z" fill="#a47551" opacity=".6" />
      <Leaf x={168} y={57} angle={80} scale={.9} tone="#9aaa8b" />
    </>}
    {kind === 'home' && <>
      <circle cx="111" cy="87" r="68" fill="#ede4d6" /><ellipse cx="113" cy="163" rx="66" ry="6" fill="#dfd1bd" />
      <path d="M102 161c10-36 10-67 21-111m-16 90c-13-17-24-21-38-27m45-3c17-14 28-18 41-19" stroke="#977751" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M120 83c-18-2-24-9-18-15-15-8-12-18 0-17-8-16 2-23 13-14 4-16 17-14 19-1 13-10 24-1 16 11 16 5 13 18-2 19 7 12-5 23-18 16" fill="#8fa17b" />
      <path d="m121 82 1-38m0 22-12-10m12 15 15-15" stroke="#657e57" strokeWidth="1.4" />
      <Leaf x={108} y={137} angle={-30} scale={1.1} tone="#afbc97" /><Leaf x={126} y={105} angle={95} scale={1} tone="#758b66" />
      <path d="M151 134c-9 9-7 19 1 24 10-3 13-12 7-23" fill="#bb9369" /><path d="M145 134c0-8 18-10 19 1Z" fill="#806247" /><path d="m154 129 2-6" stroke="#806247" strokeWidth="2" />
    </>}
  </svg>;
}
