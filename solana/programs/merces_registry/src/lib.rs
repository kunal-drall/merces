#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

declare_id!("GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi");

#[program]
pub mod merces_registry {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
