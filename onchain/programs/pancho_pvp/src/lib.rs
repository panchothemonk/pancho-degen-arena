use anchor_lang::prelude::*;

declare_id!("52nguesHaBuF4psFr2uybVnW4angLW2ZtsBRSRmdF8k3");

const BPS_DENOMINATOR: u64 = 10_000;
const SIDE_UP: u8 = 0;
const SIDE_DOWN: u8 = 1;
const SIDE_NONE: u8 = 255;
const ROUND_OPEN: u8 = 0;
const ROUND_LOCKED: u8 = 1;
const ROUND_SETTLED: u8 = 2;
const LOCK_GRACE_SECONDS: i64 = 45;

#[program]
pub mod pancho_pvp {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        fee_bps: u16,
        oracle_max_age_sec: u32,
        oracle_program: Pubkey,
    ) -> Result<()> {
        require!(fee_bps <= 1_500, PanchoError::InvalidFeeBps);

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.treasury = ctx.accounts.treasury.key();
        config.fee_bps = fee_bps;
        config.oracle_max_age_sec = oracle_max_age_sec;
        config.oracle_program = oracle_program;
        config.paused = false;
        config.bump = ctx.bumps.config;

        Ok(())
    }

    pub fn set_config(
        ctx: Context<SetConfig>,
        fee_bps: u16,
        oracle_max_age_sec: u32,
        paused: bool,
    ) -> Result<()> {
        require!(fee_bps <= 1_500, PanchoError::InvalidFeeBps);

        let config = &mut ctx.accounts.config;
        config.fee_bps = fee_bps;
        config.oracle_max_age_sec = oracle_max_age_sec;
        config.paused = paused;

        Ok(())
    }

    pub fn set_treasury(ctx: Context<SetTreasury>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.treasury = ctx.accounts.new_treasury.key();
        Ok(())
    }

    pub fn create_round(
        ctx: Context<CreateRound>,
        market: u8,
        round_id: i64,
        lock_ts: i64,
        end_ts: i64,
        feed_id: [u8; 32],
        oracle_price_account: Pubkey,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, PanchoError::ProtocolPaused);
        require!(end_ts > lock_ts, PanchoError::InvalidSchedule);

        let now = Clock::get()?.unix_timestamp;
        require!(lock_ts > now, PanchoError::InvalidSchedule);

        let round = &mut ctx.accounts.round;
        round.round_id = round_id;
        round.market = market;
        round.feed_id = feed_id;
        round.oracle_price_account = oracle_price_account;
        round.lock_ts = lock_ts;
        round.end_ts = end_ts;
        round.start_price = 0;
        round.end_price = 0;
        round.expo = 0;
        round.status = ROUND_OPEN;
        round.winner_side = SIDE_NONE;
        round.up_total = 0;
        round.down_total = 0;
        round.fee_lamports = 0;
        round.distributable_lamports = 0;
        round.bump = ctx.bumps.round;

        let up_vault = &mut ctx.accounts.up_vault;
        up_vault.round = round.key();
        up_vault.side = SIDE_UP;
        up_vault.bump = ctx.bumps.up_vault;

        let down_vault = &mut ctx.accounts.down_vault;
        down_vault.round = round.key();
        down_vault.side = SIDE_DOWN;
        down_vault.bump = ctx.bumps.down_vault;

        emit!(RoundCreated {
            round: round.key(),
            round_id,
            market,
            lock_ts,
            end_ts
        });

        Ok(())
    }

    pub fn join_round(ctx: Context<JoinRound>, side: u8, lamports: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, PanchoError::ProtocolPaused);
        require!(lamports > 0, PanchoError::InvalidStake);
        require!(side == SIDE_UP || side == SIDE_DOWN, PanchoError::InvalidSide);

        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;

        require!(round.status == ROUND_OPEN, PanchoError::RoundNotOpen);
        require!(now < round.lock_ts, PanchoError::RoundLocked);

        let cpi_accounts = anchor_lang::system_program::Transfer {
            from: ctx.accounts.user.to_account_info(),
            to: ctx.accounts.side_vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
        anchor_lang::system_program::transfer(cpi_ctx, lamports)?;

        let position = &mut ctx.accounts.position;
        if position.amount == 0 {
            position.round = round.key();
            position.user = ctx.accounts.user.key();
            position.side = side;
            position.claimed = false;
            position.bump = ctx.bumps.position;
        }
        require!(position.side == side, PanchoError::PositionSideMismatch);
        require!(!position.claimed, PanchoError::AlreadyClaimed);
        position.amount = position
            .amount
            .checked_add(lamports)
            .ok_or(PanchoError::MathOverflow)?;

        if side == SIDE_UP {
            round.up_total = round
                .up_total
                .checked_add(lamports)
                .ok_or(PanchoError::MathOverflow)?;
        } else {
            round.down_total = round
                .down_total
                .checked_add(lamports)
                .ok_or(PanchoError::MathOverflow)?;
        }

        emit!(RoundJoined {
            round: round.key(),
            user: ctx.accounts.user.key(),
            side,
            lamports,
        });

        Ok(())
    }

    pub fn lock_round(ctx: Context<LockRound>) -> Result<()> {
        require!(!ctx.accounts.config.paused, PanchoError::ProtocolPaused);

        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;

        require!(round.status == ROUND_OPEN, PanchoError::RoundAlreadyLocked);
        require!(now >= round.lock_ts, PanchoError::TooEarlyToLock);
        require!(now <= round.lock_ts + LOCK_GRACE_SECONDS, PanchoError::LockWindowExpired);

        let clock = Clock::get()?;
        let price = read_legacy_pyth_price(
            &ctx.accounts.oracle_price,
            round.oracle_price_account,
            clock.slot,
            ctx.accounts.config.oracle_max_age_sec as u64,
            ctx.accounts.config.oracle_program,
        )?;

        round.start_price = price.price;
        round.expo = price.expo;
        round.status = ROUND_LOCKED;

        emit!(RoundLocked {
            round: round.key(),
            start_price: round.start_price,
            expo: round.expo,
            locked_at: now,
        });

        Ok(())
    }

    pub fn settle_round(ctx: Context<SettleRound>) -> Result<()> {
        require!(!ctx.accounts.config.paused, PanchoError::ProtocolPaused);

        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;

        require!(now >= round.end_ts, PanchoError::TooEarlyToSettle);
        require!(round.status != ROUND_SETTLED, PanchoError::RoundAlreadySettled);

        if round.status == ROUND_OPEN {
            round.status = ROUND_SETTLED;
            round.winner_side = SIDE_NONE;
        }

        if round.status == ROUND_LOCKED {
            let clock = Clock::get()?;
            let price = read_legacy_pyth_price(
                &ctx.accounts.oracle_price,
                round.oracle_price_account,
                clock.slot,
                ctx.accounts.config.oracle_max_age_sec as u64,
                ctx.accounts.config.oracle_program,
            )?;
            round.end_price = price.price;

            if round.up_total == 0 || round.down_total == 0 || round.start_price == round.end_price {
                round.winner_side = SIDE_NONE;
            } else if round.end_price > round.start_price {
                round.winner_side = SIDE_UP;
            } else {
                round.winner_side = SIDE_DOWN;
            }

            round.status = ROUND_SETTLED;
        }

        let total = round
            .up_total
            .checked_add(round.down_total)
            .ok_or(PanchoError::MathOverflow)?;
        round.fee_lamports = total
            .checked_mul(ctx.accounts.config.fee_bps as u64)
            .ok_or(PanchoError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(PanchoError::MathOverflow)?;
        round.distributable_lamports = total
            .checked_sub(round.fee_lamports)
            .ok_or(PanchoError::MathOverflow)?;

        transfer_from_vaults(
            &ctx.accounts.up_vault.to_account_info(),
            &ctx.accounts.down_vault.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            round.fee_lamports,
        )?;

        emit!(RoundSettled {
            round: round.key(),
            winner_side: round.winner_side,
            start_price: round.start_price,
            end_price: round.end_price,
            fee_lamports: round.fee_lamports,
            distributable_lamports: round.distributable_lamports,
            settled_at: now,
        });

        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let round = &ctx.accounts.round;
        let position = &mut ctx.accounts.position;

        require!(round.status == ROUND_SETTLED, PanchoError::RoundNotSettled);
        require!(!position.claimed, PanchoError::AlreadyClaimed);
        require!(position.amount > 0, PanchoError::NothingToClaim);

        let payout = if round.winner_side == SIDE_NONE {
            proportion(position.amount, round.distributable_lamports, round.up_total + round.down_total)?
        } else if position.side == round.winner_side {
            let winner_total = if round.winner_side == SIDE_UP {
                round.up_total
            } else {
                round.down_total
            };
            proportion(position.amount, round.distributable_lamports, winner_total)?
        } else {
            0
        };

        position.claimed = true;

        if payout > 0 {
            transfer_from_vaults(
                &ctx.accounts.up_vault.to_account_info(),
                &ctx.accounts.down_vault.to_account_info(),
                &ctx.accounts.user.to_account_info(),
                payout,
            )?;
        }

        emit!(Claimed {
            round: round.key(),
            user: ctx.accounts.user.key(),
            side: position.side,
            stake: position.amount,
            payout,
        });

        Ok(())
    }
}

fn proportion(numerator: u64, total_out: u64, total_in: u64) -> Result<u64> {
    if total_in == 0 || total_out == 0 || numerator == 0 {
        return Ok(0);
    }

    numerator
        .checked_mul(total_out)
        .ok_or(error!(PanchoError::MathOverflow))?
        .checked_div(total_in)
        .ok_or(error!(PanchoError::MathOverflow))
}

fn read_legacy_pyth_price(
    oracle_price: &UncheckedAccount,
    expected_oracle_key: Pubkey,
    now_slot: u64,
    max_slot_age: u64,
    expected_oracle_program: Pubkey,
) -> Result<OraclePrice> {
    require_keys_eq!(
        oracle_price.key(),
        expected_oracle_key,
        PanchoError::UnexpectedOracleAccount
    );
    require_keys_eq!(
        *oracle_price.owner,
        expected_oracle_program,
        PanchoError::InvalidOracleOwner
    );

    let oracle_info = oracle_price.to_account_info();
    let data = oracle_info
        .try_borrow_data()
        .map_err(|_| error!(PanchoError::InvalidOraclePrice))?;
    let parsed = parse_legacy_pyth_price_account(&data).ok_or(error!(PanchoError::InvalidOraclePrice))?;
    require!(parsed.status == LEGACY_PYTH_STATUS_TRADING, PanchoError::InvalidOraclePrice);
    require!(
        now_slot.saturating_sub(parsed.pub_slot) <= max_slot_age,
        PanchoError::StaleOraclePrice
    );

    Ok(OraclePrice {
        price: parsed.price,
        expo: parsed.expo,
    })
}

const LEGACY_PYTH_MAGIC: u32 = 0xa1b2c3d4;
const LEGACY_PYTH_VERSION_2: u32 = 2;
const LEGACY_PYTH_ACCOUNT_TYPE_PRICE: u32 = 3;
const LEGACY_PYTH_STATUS_TRADING: u32 = 1;
const LEGACY_PYTH_OFFSET_MAGIC: usize = 0;
const LEGACY_PYTH_OFFSET_VERSION: usize = 4;
const LEGACY_PYTH_OFFSET_ACCOUNT_TYPE: usize = 8;
const LEGACY_PYTH_OFFSET_EXPO: usize = 20;
const LEGACY_PYTH_OFFSET_AGG_PRICE: usize = 208;
const LEGACY_PYTH_OFFSET_AGG_STATUS: usize = 224;
const LEGACY_PYTH_OFFSET_AGG_PUB_SLOT: usize = 232;
const LEGACY_PYTH_MIN_LEN: usize = 240;

struct LegacyPythPrice {
    price: i64,
    expo: i32,
    status: u32,
    pub_slot: u64,
}

fn read_u32_le(data: &[u8], offset: usize) -> Option<u32> {
    let bytes = data.get(offset..offset + 4)?;
    Some(u32::from_le_bytes(bytes.try_into().ok()?))
}

fn read_i32_le(data: &[u8], offset: usize) -> Option<i32> {
    let bytes = data.get(offset..offset + 4)?;
    Some(i32::from_le_bytes(bytes.try_into().ok()?))
}

fn read_i64_le(data: &[u8], offset: usize) -> Option<i64> {
    let bytes = data.get(offset..offset + 8)?;
    Some(i64::from_le_bytes(bytes.try_into().ok()?))
}

fn read_u64_le(data: &[u8], offset: usize) -> Option<u64> {
    let bytes = data.get(offset..offset + 8)?;
    Some(u64::from_le_bytes(bytes.try_into().ok()?))
}

fn parse_legacy_pyth_price_account(data: &[u8]) -> Option<LegacyPythPrice> {
    if data.len() < LEGACY_PYTH_MIN_LEN {
        return None;
    }

    if read_u32_le(data, LEGACY_PYTH_OFFSET_MAGIC)? != LEGACY_PYTH_MAGIC {
        return None;
    }
    if read_u32_le(data, LEGACY_PYTH_OFFSET_VERSION)? != LEGACY_PYTH_VERSION_2 {
        return None;
    }
    if read_u32_le(data, LEGACY_PYTH_OFFSET_ACCOUNT_TYPE)? != LEGACY_PYTH_ACCOUNT_TYPE_PRICE {
        return None;
    }

    Some(LegacyPythPrice {
        price: read_i64_le(data, LEGACY_PYTH_OFFSET_AGG_PRICE)?,
        expo: read_i32_le(data, LEGACY_PYTH_OFFSET_EXPO)?,
        status: read_u32_le(data, LEGACY_PYTH_OFFSET_AGG_STATUS)?,
        pub_slot: read_u64_le(data, LEGACY_PYTH_OFFSET_AGG_PUB_SLOT)?,
    })
}

fn transfer_from_vaults(up_vault: &AccountInfo, down_vault: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    let mut remaining = amount;
    let up_available = up_vault.lamports();
    let take_up = up_available.min(remaining);
    if take_up > 0 {
        **up_vault.try_borrow_mut_lamports()? = up_available
            .checked_sub(take_up)
            .ok_or(error!(PanchoError::MathOverflow))?;
        **to.try_borrow_mut_lamports()? = to
            .lamports()
            .checked_add(take_up)
            .ok_or(error!(PanchoError::MathOverflow))?;
        remaining = remaining
            .checked_sub(take_up)
            .ok_or(error!(PanchoError::MathOverflow))?;
    }

    if remaining > 0 {
        let down_available = down_vault.lamports();
        let take_down = down_available.min(remaining);
        if take_down > 0 {
            **down_vault.try_borrow_mut_lamports()? = down_available
                .checked_sub(take_down)
                .ok_or(error!(PanchoError::MathOverflow))?;
            **to.try_borrow_mut_lamports()? = to
                .lamports()
                .checked_add(take_down)
                .ok_or(error!(PanchoError::MathOverflow))?;
            remaining = remaining
                .checked_sub(take_down)
                .ok_or(error!(PanchoError::MathOverflow))?;
        }
    }

    require!(remaining == 0, PanchoError::InsufficientVaultLiquidity);
    Ok(())
}

struct OraclePrice {
    price: i64,
    expo: i32,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: destination treasury wallet
    pub treasury: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin
    )]
    pub config: Account<'info, GlobalConfig>,
}

#[derive(Accounts)]
pub struct SetTreasury<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin
    )]
    pub config: Account<'info, GlobalConfig>,
    /// CHECK: destination treasury wallet
    pub new_treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(market: u8, round_id: i64)]
pub struct CreateRound<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init,
        payer = admin,
        space = 8 + Round::INIT_SPACE,
        seeds = [b"round".as_ref(), &[market], &round_id.to_le_bytes()],
        bump
    )]
    pub round: Account<'info, Round>,
    #[account(
        init,
        payer = admin,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", round.key().as_ref(), &[SIDE_UP]],
        bump
    )]
    pub up_vault: Account<'info, Vault>,
    #[account(
        init,
        payer = admin,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", round.key().as_ref(), &[SIDE_DOWN]],
        bump
    )]
    pub down_vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct JoinRound<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub round: Account<'info, Round>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", round.key().as_ref(), user.key().as_ref(), &[side]],
        bump
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        seeds = [b"vault", round.key().as_ref(), &[side]],
        bump = side_vault.bump,
        constraint = side_vault.round == round.key() @ PanchoError::VaultRoundMismatch,
        constraint = side_vault.side == side @ PanchoError::InvalidSide
    )]
    pub side_vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LockRound<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub round: Account<'info, Round>,
    /// CHECK: validated in handler
    pub oracle_price: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SettleRound<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [b"vault", round.key().as_ref(), &[SIDE_UP]],
        bump = up_vault.bump,
        constraint = up_vault.round == round.key() @ PanchoError::VaultRoundMismatch
    )]
    pub up_vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"vault", round.key().as_ref(), &[SIDE_DOWN]],
        bump = down_vault.bump,
        constraint = down_vault.round == round.key() @ PanchoError::VaultRoundMismatch
    )]
    pub down_vault: Account<'info, Vault>,
    /// CHECK: validated in handler
    pub oracle_price: UncheckedAccount<'info>,
    /// CHECK: validated against config.treasury
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [b"position", round.key().as_ref(), user.key().as_ref(), &[position.side]],
        bump = position.bump,
        constraint = position.round == round.key() @ PanchoError::PositionRoundMismatch,
        constraint = position.user == user.key() @ PanchoError::PositionUserMismatch
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        seeds = [b"vault", round.key().as_ref(), &[SIDE_UP]],
        bump = up_vault.bump,
        constraint = up_vault.round == round.key() @ PanchoError::VaultRoundMismatch
    )]
    pub up_vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"vault", round.key().as_ref(), &[SIDE_DOWN]],
        bump = down_vault.bump,
        constraint = down_vault.round == round.key() @ PanchoError::VaultRoundMismatch
    )]
    pub down_vault: Account<'info, Vault>,
}

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub oracle_program: Pubkey,
    pub fee_bps: u16,
    pub oracle_max_age_sec: u32,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub round_id: i64,
    pub market: u8,
    pub feed_id: [u8; 32],
    pub oracle_price_account: Pubkey,
    pub lock_ts: i64,
    pub end_ts: i64,
    pub start_price: i64,
    pub end_price: i64,
    pub expo: i32,
    pub status: u8,
    pub winner_side: u8,
    pub up_total: u64,
    pub down_total: u64,
    pub fee_lamports: u64,
    pub distributable_lamports: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub round: Pubkey,
    pub side: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub round: Pubkey,
    pub user: Pubkey,
    pub side: u8,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[event]
pub struct RoundCreated {
    pub round: Pubkey,
    pub round_id: i64,
    pub market: u8,
    pub lock_ts: i64,
    pub end_ts: i64,
}

#[event]
pub struct RoundJoined {
    pub round: Pubkey,
    pub user: Pubkey,
    pub side: u8,
    pub lamports: u64,
}

#[event]
pub struct RoundLocked {
    pub round: Pubkey,
    pub start_price: i64,
    pub expo: i32,
    pub locked_at: i64,
}

#[event]
pub struct RoundSettled {
    pub round: Pubkey,
    pub winner_side: u8,
    pub start_price: i64,
    pub end_price: i64,
    pub fee_lamports: u64,
    pub distributable_lamports: u64,
    pub settled_at: i64,
}

#[event]
pub struct Claimed {
    pub round: Pubkey,
    pub user: Pubkey,
    pub side: u8,
    pub stake: u64,
    pub payout: u64,
}

#[error_code]
pub enum PanchoError {
    #[msg("Invalid fee bps")]
    InvalidFeeBps,
    #[msg("Protocol is paused")]
    ProtocolPaused,
    #[msg("Invalid schedule")]
    InvalidSchedule,
    #[msg("Invalid side")]
    InvalidSide,
    #[msg("Invalid stake")]
    InvalidStake,
    #[msg("Round is not open")]
    RoundNotOpen,
    #[msg("Round is locked")]
    RoundLocked,
    #[msg("Position side mismatch")]
    PositionSideMismatch,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Round already locked")]
    RoundAlreadyLocked,
    #[msg("Too early to lock")]
    TooEarlyToLock,
    #[msg("Lock window expired")]
    LockWindowExpired,
    #[msg("Too early to settle")]
    TooEarlyToSettle,
    #[msg("Round already settled")]
    RoundAlreadySettled,
    #[msg("Insufficient vault liquidity")]
    InsufficientVaultLiquidity,
    #[msg("Round not settled")]
    RoundNotSettled,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Vault round mismatch")]
    VaultRoundMismatch,
    #[msg("Position round mismatch")]
    PositionRoundMismatch,
    #[msg("Position user mismatch")]
    PositionUserMismatch,
    #[msg("Invalid oracle price update")]
    InvalidOraclePrice,
    #[msg("Unexpected oracle account")]
    UnexpectedOracleAccount,
    #[msg("Invalid oracle owner")]
    InvalidOracleOwner,
    #[msg("Stale oracle price")]
    StaleOraclePrice,
}
