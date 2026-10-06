const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const OUT = process.env.OUT || __dirname + '/out';
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:2});
await p.goto('file://'+__dirname+'/m3c.html',{waitUntil:'networkidle'});await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(600);
const names={s11:'11-version-control',s12:'12-release-pipeline',s13:'13-quest-and-dialog',s14:'14-animation',s15:'15-vfx-and-materials',s16:'16-hud-layout',s17:'17-audio',s18:'18-localization',s19:'19-playtests',d7:'diagram-07-workspaces'};
const only=process.argv[2];
for(const [id,n] of Object.entries(names)) { if(only && !only.split(',').includes(id)) continue; await p.locator('#'+id).screenshot({path:n.startsWith('diagram')?`${OUT}/${n}.png`:`${OUT}/ux-${n}.png`}); }
await b.close();})().catch(e=>{console.error(e);process.exit(1)});
