#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

declare_id!("2PuKMkGkGLCwsDMLCmm2bcbzjxtabvt9LVJni154ezRt");

#[program]
pub mod merces_hook {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
