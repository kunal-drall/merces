import { createPool, migrate } from '@merces/db';
import { formsConfig } from '../../services/src/forms/config.ts';
import { deliverFormMail, pruneForms } from '../../services/src/forms/mail.ts';
const config=formsConfig();
if(!config)throw new Error('Forms worker requires approved forms configuration and host secrets.');
const pool=createPool();await migrate(pool);
let stopped=false;for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stopped=true;});
let cleanup=0;
try{while(!stopped){try{if(Date.now()-cleanup>3600_000){await pruneForms(pool);cleanup=Date.now();}const worked=await deliverFormMail(pool,config);if(!worked)await new Promise(r=>setTimeout(r,2000));}catch{console.error('[forms-worker] processing failed');await new Promise(r=>setTimeout(r,5000));}}}finally{await pool.end();}
