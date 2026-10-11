import { defineRoute, type AppContext } from '@merces/api';
import { AppError } from '@merces/core';
import type { FastifyInstance } from 'fastify';
import { formsConfig } from './config.ts';
import { formIds, type FormId } from './schema.ts';
import { authorized, submitForm } from './service.ts';
import { receiveWebhook } from './mail.ts';
export function registerFormsRoutes(app: FastifyInstance,ctx: AppContext): void {
  defineRoute(app,ctx,{method:'POST',url:'/forms/:form',access:'public',bodyLimit:16*1024,handler:async(req,reply)=>{
    reply.header('Cache-Control','no-store');
    const config=formsConfig();if(!config)throw new AppError(503,'Unavailable','forms are unavailable');
    if(!authorized(config,req.headers['x-merces-forms-token']))throw AppError.unauthorized();
    const form=(req.params as {form:string}).form;
    if(!formIds.includes(form as FormId))throw AppError.notFound('form');
    try{return await submitForm(ctx.pool,config,form as FormId,req.body);}catch(e){if(e instanceof AppError){if(e.status===429)reply.header('Retry-After','3600');throw e;}throw new AppError(503,'Unavailable','forms are unavailable');}
  }});
  void app.register(async scoped=>{
    scoped.removeContentTypeParser('application/json');
    scoped.addContentTypeParser('application/json',{parseAs:'string'},(_req,body,done)=>done(null,body));
    defineRoute(scoped,ctx,{method:'POST',url:'/forms/webhooks/resend',access:'public',bodyLimit:64*1024,handler:async(req,reply)=>{
      reply.header('Cache-Control','no-store');const config=formsConfig();if(!config)throw new AppError(503,'Unavailable','forms are unavailable');
      if(typeof req.body!=='string')throw AppError.badRequest('invalid webhook');
      try{await receiveWebhook(ctx.pool,config,req.body,req.headers);}catch{throw AppError.badRequest('webhook rejected');}return {ok:true};
    }});
  });
}
