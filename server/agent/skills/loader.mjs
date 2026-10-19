import { readFileSync } from 'node:fs';
import { SKILLS } from './registry.mjs';
const cache=new Map();
export function loadSkills(route,maxBytes=900) {
  const loaded=[];let text='';
  for(const id of route.required_skills||[]){
    if(!Object.hasOwn(SKILLS,id))continue;
    const meta=SKILLS[id];if(!meta.intents.includes(route.intent))continue;
    if(!cache.has(id))cache.set(id,JSON.parse(readFileSync(new URL(meta.file,import.meta.url),'utf8')));
    const body=cache.get(id),section=`[${id}@${meta.version}] ${body.instructions}\n`;
    if(Buffer.byteLength(text+section)>maxBytes)continue;
    text+=section;loaded.push({id,version:meta.version});
  }
  return {text,loaded,bytes:Buffer.byteLength(text)};
}
