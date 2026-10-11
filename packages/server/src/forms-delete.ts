import { createPool } from '@merces/db';
import { formsConfig } from '../../services/src/forms/config.ts';
import { eraseForms } from '../../services/src/forms/service.ts';
// Read one verified request's address from stdin; no address in process arguments or logs.
const config=formsConfig();if(!config)throw Error('Forms configuration unavailable.');
const chunks:Buffer[]=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>512)throw Error('Invalid deletion input.');chunks.push(Buffer.from(chunk));}
const email=Buffer.concat(chunks).toString('utf8').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw Error('Invalid deletion input.');
const pool=createPool();try{await eraseForms(pool,config,email);console.log('Form deletion and suppression completed.');}finally{await pool.end();}
