// Fixed read-only fd3 reader. The bundler supplies the closed ARM64 constant.
// Public Darwin64 layouts: sys/stat.h, sys/mount.h, sys/attr.h, sys/kauth.h.
// Explicit byte buffers avoid JXA's unsupported nested struct metadata.
if (ARM64) {
  ObjC.bindFunction('fstat', ['int', ['int', 'void *']]);
  ObjC.bindFunction('fstatfs', ['int', ['int', 'void *']]);
  ObjC.bindFunction('fstatx_np', ['int', ['int', 'void *', 'void *']]);
} else {
  ObjC.bindFunction('fstat$INODE64', ['int', ['int', 'void *']]);
  ObjC.bindFunction('fstatfs$INODE64', ['int', ['int', 'void *']]);
  ObjC.bindFunction('fstatx_np$INODE64', ['int', ['int', 'void *', 'void *']]);
}
ObjC.bindFunction('filesec_init', ['void *', []]);
ObjC.bindFunction('filesec_free', ['void', ['void *']]);
ObjC.bindFunction('filesec_get_property', ['int', ['void *', 'int', 'void *']]);
ObjC.bindFunction('filesec_query_property', ['int', ['void *', 'int', 'void *']]);
ObjC.bindFunction('fgetattrlist', ['int', ['int', 'void *', 'void *', 'unsigned long', 'unsigned long']]);
function run() {
  let reason = 'bridge', sec = null;
  function refuse(value) { reason = value; throw Error(value); }
  function u32(p, at) { return p[at] + p[at+1]*256 + p[at+2]*65536 + p[at+3]*16777216; }
  function u64(p, at) { let n = 0n; for (let i=7;i>=0;i--) n=n*256n+BigInt(p[at+i]); return String(n); }
  function data(n) { const b=$.NSMutableData.dataWithLength(n); if (b.isNil() || Number(b.length)!==n) refuse('allocation'); return b; }
  const statCall = ARM64 ? $.fstat : $['fstat$INODE64'];
  const fsCall = ARM64 ? $.fstatfs : $['fstatfs$INODE64'];
  const securityCall = ARM64 ? $.fstatx_np : $['fstatx_np$INODE64'];
  try {
    reason = 'request';
    const input=$.NSFileHandle.fileHandleWithStandardInput.readDataOfLength(80);
    if (Number(input.length)>=80 || Number($.NSFileHandle.fileHandleWithStandardInput.readDataOfLength(1).length)!==0) refuse('request');
    const text=$.NSString.alloc.initWithDataEncoding(input,$.NSUTF8StringEncoding);
    if (text.isNil()) refuse('request');
    const request=ObjC.unwrap(text).match(/^OBSYNC_ACL_V1 (0|[1-9][0-9]{0,19}) (0|[1-9][0-9]{0,19})\n$/);
    if (!request || BigInt(request[1])>4294967295n || BigInt(request[2])>18446744073709551615n) refuse('request');
    reason = 'descriptor';
    const stat=data(4096), after=data(4096);
    if (statCall(3,stat.mutableBytes)!==0) refuse('descriptor');
    const p=stat.mutableBytes;
    if (String(u32(p,0))!==request[1] || u64(p,8)!==request[2]) refuse('identity');
    if (((p[4]+p[5]*256)&0xf000)!==0x4000) refuse('directory');
    reason = 'filesystem';
    const fs=data(4096);
    if (fsCall(3,fs.mutableBytes)!==0) refuse('filesystem');
    const f=fs.mutableBytes, flags=u32(f,64);
    if ((flags&0x1000)===0 || (flags&0x200000)!==0 ||
        f[72]!==97 || f[73]!==112 || f[74]!==102 || f[75]!==115 || f[76]!==0) refuse('filesystem');
    reason = 'security'; sec=$.filesec_init();
    if (Ref.equals(sec,Ref('void *')[0])) { sec=null; refuse('allocation'); }
    const stx=data(4096), owner=data(4), group=data(4), mode=data(4), valid=data(4);
    if (securityCall(3,stx.mutableBytes,sec)!==0 ||
        $.filesec_get_property(sec,1,owner.mutableBytes)!==0 ||
        $.filesec_get_property(sec,2,group.mutableBytes)!==0 ||
        $.filesec_get_property(sec,4,mode.mutableBytes)!==0 ||
        $.filesec_query_property(sec,5,valid.mutableBytes)!==0) refuse('security');
    if (u32(owner.mutableBytes,0)!==u32(p,16) || u32(group.mutableBytes,0)!==u32(p,20) ||
        u32(mode.mutableBytes,0)!==p[4]+p[5]*256) refuse('security_identity');
    for (let i=0;i<24;i++) if (stx.mutableBytes[i]!==p[i]) refuse('security_identity');
    const present=u32(valid.mutableBytes,0)!==0;
    reason = 'attributes';
    const attrs=data(24), buffer=data(4096), a=attrs.mutableBytes;
    a[0]=5; a[6]=0x40; a[7]=0x80;
    if ($.fgetattrlist(3,a,buffer.mutableBytes,4096,4)!==0) refuse('attributes');
    const b=buffer.mutableBytes, length=u32(b,0), bits=u32(b,4);
    if (length<24 || length>4096 || (bits!==0x80000000 && bits!==0x80400000)) refuse('attribute_shape');
    for (let i=8;i<24;i++) if (b[i]!==0) refuse('attribute_shape');
    let count=0, classification='absent';
    if (bits===0x80000000) {
      if (present || (length!==24 && length!==32)) refuse('absence_unproven');
      for (let i=24;i<length;i++) if (b[i]!==0) refuse('absence_unproven');
    } else {
      if (length<76 || u32(b,24)!==8 || u32(b,28)!==length-32 || u32(b,32)!==0x012cc16d) refuse('acl_shape');
      count=u32(b,68);
      if (count>128 || length!==76+24*count || (u32(b,72)&~0x20000)!==0 || (count && !present)) refuse('acl_count');
      classification=count?'deny_only':'empty';
      for (let i=0;i<count;i++) {
        const flags=u32(b,76+i*24+16), rights=u32(b,76+i*24+20);
        if ((flags&~0x1ff)!==0 || (rights&~0x1f03ffe)!==0 || (flags&15)!==2) refuse('ace_grants_or_unknown');
      }
    }
    reason = 'recheck';
    if (statCall(3,after.mutableBytes)!==0) refuse('recheck');
    for (let i=0;i<24;i++) if (after.mutableBytes[i]!==p[i]) refuse('changed');
    for (let i=64;i<80;i++) if (after.mutableBytes[i]!==p[i] || stx.mutableBytes[i]!==p[i]) refuse('changed');
    return JSON.stringify({v:1,ok:true,kind:classification,entries:count,errno:null});
  } catch (_) {
    return JSON.stringify({v:1,ok:false,reason:reason,errno:null});
  } finally { if (sec!==null) $.filesec_free(sec); }
}
