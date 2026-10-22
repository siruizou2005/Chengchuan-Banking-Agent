// Runs the suite, then reruns only the failed tests up to twice, so a timing flake on a busy CI runner
// does not fail the build while a real failure still does.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const attempts=3,dir=mkdtempSync(join(tmpdir(),'bank-tests-')),state=join(dir,'rerun.json');
let status=1;
try {
  for(let i=1;i<=attempts&&status!==0;i++){
    if(i>1)console.log(`\n重跑失败的测试（第 ${i}/${attempts} 次）`);
    status=spawnSync(process.execPath,['--test',`--test-rerun-failures=${state}`,...process.argv.slice(2),'tests/*.test.mjs'],{stdio:'inherit'}).status??1;
  }
} finally { rmSync(dir,{recursive:true,force:true}); }
process.exit(status);
