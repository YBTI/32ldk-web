/* 32LDK game engine — shared by server (Node) and browser (1台モード). 公式説明書準拠 */
(function(root){
const DEAL = {3:[5,5],4:[4,4],5:[3,3],6:[2,2]}; // 人数: [除外, 手札]
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function roundsFor(g){return g.settings.mode==='short'?1:g.settings.mode==='long'?g.players.length:2}
function isRun(vals){const s=[...vals].sort((a,b)=>a-b);for(let i=1;i<s.length;i++)if(s[i]!==s[i-1]+1)return false;return s.length>0}
function pushLog(g,t){g.log=(g.log||[]);g.log.unshift(t);if(g.log.length>30)g.log.length=30}
function spiritTop(g){return g.spirit[g.spirit.length-1]}

function newGame(g){
  g.round=1; g.totalRounds=roundsFor(g); g.log=[];
  g.players.forEach(p=>{p.scores=[];p.total=0;p.hand=[]});
  startRound(g, Math.floor(Math.random()*g.players.length));
}
function startRound(g,startSeat){
  const n=g.players.length, [ex,h]=DEAL[n];
  const deck=shuffle(Array.from({length:32},(_,i)=>i+1));
  deck.splice(0,ex); g.excluded=ex;
  g.players.forEach(p=>{p.hand=deck.splice(0,h).map(v=>({v,k:0}))});
  g.spirit=[deck.pop()]; g.doors=deck;
  g.turn=startSeat; g.lastDoorBy=null; g.status='playing'; g.last=null;
  g.seq=(g.seq||0)+1;
  pushLog(g,`― 第${g.round}ゲーム開始。最初の霊は「${g.spirit[0]}」。${g.players[startSeat].name} から ―`);
}
function canAct(g,seat){return g.doors.length>0||g.players.some(p=>p.hand.length>0)}
function act(g,seat,a){
  if(g.status!=='playing')return 'いまはカードを出せません';
  if(g.turn!==seat)return 'あなたの番ではありません';
  const me=g.players[seat], n=g.players.length;
  let played, src=a.type, desc;
  if(a.type==='door'){
    if(!g.doors.length)return '扉が残っていません';
    const i=a.i|0; if(i<0||i>=g.doors.length)return 'その扉はありません';
    played=[g.doors.splice(i,1)[0]]; g.lastDoorBy=seat; desc='扉を開けた';
  }else if(a.type==='hand'){
    const vals=[...new Set(a.vals)].sort((x,y)=>x-y);
    if(!vals.length)return 'カードを選んでください';
    if(!isRun(vals))return '複数枚は連番でのみ出せます';
    for(const v of vals)if(!me.hand.some(c=>c.v===v))return '手札にないカードです';
    me.hand=me.hand.filter(c=>!vals.includes(c.v)); played=vals; desc='手札から出した';
  }else if(a.type==='steal'){
    const t=a.t|0, tp=g.players[t];
    if(!tp||t===seat)return '相手を選んでください';
    if(!tp.hand.length)return 'その相手は手札がありません';
    const idx=Math.floor(Math.random()*tp.hand.length);
    played=[tp.hand.splice(idx,1)[0].v]; desc=`${tp.name} の手札から引いた`;
  }else return '不明な操作です';
  played.sort((x,y)=>x-y);
  const t0=spiritTop(g), mx=played[played.length-1];
  const chain=!!g.settings.chain && played.includes(t0+1);
  let result,taken=0;
  if(mx>t0){g.spirit.push(...played);result='suppress'}
  else{taken=g.spirit.length;me.hand.push(...g.spirit.map(v=>({v,k:1})));g.spirit=played.slice();result='possessed'}
  g.last={seat,src,t:a.t,played,top:t0,result,taken,chain:chain&&result==='suppress'};
  g.seq=(g.seq||0)+1;
  const pl=played.length>1?`${played[0]}〜${mx}`:`${mx}`;
  pushLog(g, result==='suppress'
    ? `${me.name}：${desc}「${pl}」→ ${t0} を抑え込んだ${g.last.chain?'（連続出し）':''}`
    : `${me.name}：${desc}「${pl}」→ ${t0} に負け、霊${taken}枚に取り憑かれた`);
  if(g.last.chain && canAct(g,seat)){ /* 同じ人がもう一度 */ }
  else if(!g.doors.length){ endRound(g) }
  else { g.turn=(seat+1)%n }
  return null;
}
function endRound(g){
  g.players.forEach(p=>{const c=p.hand.length;p.scores.push(c);if(g.round>=2&&c===0)p.total=0;else p.total+=c});
  g.status=g.round>=g.totalRounds?'finished':'roundEnd';
  pushLog(g,`― 第${g.round}ゲーム終了 ―`);
}
function nextRound(g){
  if(g.status!=='roundEnd')return 'まだ次のゲームに進めません';
  g.round++; const n=g.players.length;
  startRound(g, g.lastDoorBy==null?0:(g.lastDoorBy+1)%n); return null;
}
function winners(g){const m=Math.min(...g.players.map(p=>p.total));return g.players.map((p,i)=>p.total===m?i:-1).filter(i=>i>=0)}


const E={DEAL,shuffle,roundsFor,isRun,pushLog,spiritTop,newGame,startRound,canAct,act,endRound,nextRound,winners};
if(typeof module!=='undefined'&&module.exports)module.exports=E;else root.E=E;
})(typeof self!=='undefined'?self:this);
