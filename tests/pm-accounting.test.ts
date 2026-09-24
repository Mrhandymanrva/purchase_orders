import {test} from 'node:test';
import assert from 'node:assert/strict';
import {POST} from '../app/api/pm-accounting/route';
import {encryptToken} from '../lib/token-crypto';
test('PM accounting bridge authenticates, binds company, escapes queries and sends W-9 / tax fields safely',async()=>{
 const old={...process.env},globals=globalThis as any,oldPool=globals.richmondPool,oldFetch=globalThis.fetch;const calls:any[]=[];
 try{
 Object.assign(process.env,{NODE_ENV:'production',DEMO_MODE:'false',APP_USER:'pm-test',APP_PASSWORD:'long-test-password-for-bridge',PM_ACCOUNTING_KEY:'k'.repeat(48),DATABASE_URL:'postgres://test-only',QBO_ENV:'sandbox',QBO_CLIENT_ID:'test-client',QBO_REALM_ID:'123',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')});
 const query=async(sql:string)=>({rows:sql.includes('app_state')?[{payload:{revision:0}}]:sql.includes('oauth_tokens')?[{payload:encryptToken(JSON.stringify({accessToken:'test-access',expiresAt:Date.now()+3600000}))}]:[]});globals.richmondPool={query,connect:async()=>({query,release(){}})};
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});if(String(url).includes('/query?'))return Response.json({QueryResponse:{}});if(String(url).includes('/upload?')){const form=init!.body as FormData;const metadata=JSON.parse(await (form.get('file_metadata_01') as Blob).text());assert.equal(metadata.AttachableRef[0].EntityRef.type,'Vendor');assert.equal(metadata.AttachableRef[0].EntityRef.value,'31');return Response.json({AttachableResponse:[{Attachable:{Id:'41'}}]});}if(!init?.body)return Response.json({Vendor:{Id:'31',SyncToken:'2',Active:true,DisplayName:'Test Vendor',TaxIdentifier:'PRIVATE',PrimaryEmailAddr:{Address:'old@example.test'}}});const body=JSON.parse(String(init.body));if(body.TaxIdentifier){assert.equal(body.TaxIdentifier,'000000000');assert.equal(body.Vendor1099,true);assert.equal(body.SyncToken,'2');return Response.json({Vendor:{Id:'31',TaxIdentifier:'XXX-XX-0000'}});}return Response.json({Vendor:{Id:'31'}});};
 const headers={Authorization:'Basic '+Buffer.from('pm-test:long-test-password-for-bridge').toString('base64'),'x-pm-accounting-key':'k'.repeat(48),'Content-Type':'application/json'};
 const request=(body:any,h:any=headers)=>POST(new Request('https://app.example/api/pm-accounting',{method:'POST',headers:h,body:JSON.stringify(body)}));
 assert.equal((await request({action:'catalog'},{})).status,403);
 assert.equal((await request({action:'deleteEverything'})).status,400);
 assert.equal((await request({action:'vendors',name:'Test',expectedRealm:'999'})).status,409);assert.equal(calls.length,0);
 await request({action:'vendors',name:"O'Brien"});assert.match(decodeURIComponent(calls[0].url),/O\\'Brien/);
 const directory=await request({action:'vendorDirectory',start:101,name:"O'Brien"});assert.equal(directory.status,200);assert.ok(calls.some(c=>decodeURIComponent(c.url).includes('STARTPOSITION 101')));
 const read=await request({action:'vendor',id:'31'});assert.equal((await read.text()).includes('TaxIdentifier'),false);
 const profile={DisplayName:'PM Name',CompanyName:'PM Name',PrimaryEmailAddr:{Address:'new@example.test'},PrimaryPhone:{FreeFormNumber:'8045550000'},BillAddr:{Line1:'New address'},GivenName:'New',FamilyName:'Contact',Notes:'PM notes'};
 const missingBinding=await request({action:'syncVendor',vendorId:'31',expectedName:'Test Vendor',requestId:'12345678-1234-4234-8234-123456789013',payload:profile});assert.equal(missingBinding.status,400);
 const synced=await request({action:'syncVendor',expectedRealm:'123',vendorId:'31',expectedName:'Test Vendor',requestId:'12345678-1234-4234-8234-123456789013',payload:profile});assert.equal(synced.status,200);
 const write=calls.map(c=>{try{return JSON.parse(String(c.init?.body));}catch{return {};}}).find(b=>b.DisplayName==='PM Name');assert.equal(write.sparse,true);assert.equal(write.SyncToken,'2');assert.equal(write.PrimaryEmailAddr.Address,'new@example.test');assert.equal(write.TaxIdentifier,undefined);
 const tax=await request({action:'tax',expectedRealm:'123',vendorId:'31',taxId:'000000000',vendor1099:true,requestId:'12345678-1234-4234-8234-123456789012'});assert.equal(tax.status,200);assert.equal((await tax.text()).includes('TaxIdentifier'),false);
 const w9=await request({action:'w9',expectedRealm:'123',vendorId:'31',documentId:'12345678-1234-4234-8234-123456789012',mediaType:'application/pdf',content:Buffer.from('%PDF-test-only').toString('base64'),checkOnly:false});assert.equal(w9.status,200);assert.ok(calls.some(c=>c.url.includes('/upload?')));
 const before=calls.filter(c=>c.url.includes('/upload?')).length;await request({action:'w9',expectedRealm:'123',vendorId:'31',documentId:'12345678-1234-4234-8234-123456789012',mediaType:'application/pdf',content:'',checkOnly:true});assert.equal(calls.filter(c=>c.url.includes('/upload?')).length,before);
 }finally{globalThis.fetch=oldFetch;globals.richmondPool=oldPool;for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);}
});
