#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

declare_id!("ALQgHjCyfNAtP5mWxYny5i2eW61pK6etSC8Vx6PpgHhA");

#[program]
pub mod mock_usdg_hook {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
