#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

declare_id!("EuaPg2nTXsf3CmmeJMfdiQb4C2hU7AfLfFyDLpD69six");

#[program]
pub mod merces_protocol {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
