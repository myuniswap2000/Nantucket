const Database = require("./database");
// src.network.webthree
const TxManager = require("./network/webthree/txmanager");
const Comptroller = require("./network/webthree/compound/comptroller");
const PriceOracle = require("./network/webthree/compound/priceoracle");
const Tokens = require("./network/webthree/compound/ctoken");

new TxManager();
TxManager.shared.init("ACCOUNT_PUBLIC_KEY", "ACCOUNT_PRIVATE_KEY");

class Main extends Database {
  constructor(
    feeMinMultiplier,
    feeMaxMultiplier,
    minRevenueFeeRatio,
    numLowCandidates,
    highRevenueThresh,
    numHighCandidates
  ) {
    /**
     * Constructs a `Main` object
     *
     * @param {number} feeMinMultiplier When sending transactions, use
     *    market-recommended gas price multiplied by this amount
     * @param {number} feeMaxMultiplier When sending transactions for
     *    high-valued targets, scale gas price up to this many times its
     *    market-recommended value
     * @param {number} minRevenueFeeRatio When choosing liquidation
     *    candidates, ensure (revenue / fee) is greater than this number
     * @param {number} numLowCandidates After applying the
     *    `minRevenueFeeRatio` threshold, users are ranked by liquidity
     *    (lowest to highest). This specifies how many candidates
     *    should be taken from the top of that list
     * @param {number} highRevenueThresh When choosing high-value liquidation
     *    candidates, ensure the revenue is greater than this amount
     * @param {number} numHighCandidates This specifies how many candidates
     *    should be taken from the portion of the user list with revenue >
     *    highRevenueThresh
     *
     */
    super();

    this._feeMinMultiplier = feeMinMultiplier;
    this._feeMaxMultiplier = feeMaxMultiplier;
    this._minRevenueFeeRatio = minRevenueFeeRatio;
    this._numLowCandidates = Math.floor(numLowCandidates);
    this._highRevenueThresh = highRevenueThresh;
    this._numHighCandidates = Math.floor(numHighCandidates);

    this._liquiCandidates = [];
  }

  async getGasPrice(forHighValueTarget = false) {
    const marketValue = await web3.eth.getGasPrice();

    return (
      marketValue *
      (forHighValueTarget ? this._feeMaxMultiplier : this._feeMinMultiplier)
    );
  }

  async getTxFee_Eth(forHighValueTarget = false, gas = 1000000) {
    return (await this.getGasPrice(forHighValueTarget)) * (gas / 1e18);
  }

  _liquiCandidatesClear() {
    this._liquiCandidates = [];
  }

  async _liquiCandidatesConcat(count, min_Eth) {
    this._liquiCandidates = this._liquiCandidates.concat(
      await this._tUsers.getLiquidationCandidates(count, min_Eth)
    );
  }

  async updateLiquidationCandidates() {
    this._liquiCandidatesClear();

    await this._liquiCandidatesConcat(
      this._numLowCandidates,
      (await this.getTxFee_Eth()) * this._minRevenueFeeRatio
    );
    await this._liquiCandidatesConcat(
      this._numHighCandidates,
      this._highRevenueThresh
    );
  }

  async onNewBlock() {
    const closeFact = await Comptroller.mainnet.closeFactor();
    const liqIncent = await Comptroller.mainnet.liquidationIncentive();
    const gasPrice = await web3.eth.getGasPrice();

    for (let target of this._liquiCandidates) {
      // This is pairID 13 and 42 (DAI and SAI). There's no AAVE pool for it.
      if (
        (target.ctokenidpay == 2 && target.ctokenidseize == 6) ||
        (target.ctokenidpay == 6 && target.ctokenidseize == 2)
      )
        continue;

      // Get the target user's address as a string
      const userAddr = "0x" + target.address;

      // Check if user can be liquidated
      Comptroller.mainnet.accountLiquidityOf(userAddr).then(async res => {
        if (res[1] > 0.0) {
          // Target has negative liquidity (positive shortfall). We're good to go
          const repayAddr =
            "0x" + (await this._tCTokens.getAddress(target.ctokenidpay));
          const seizeAddr =
            "0x" + (await this._tCTokens.getAddress(target.ctokenidseize));

          let repayAmnt =
            (closeFact - 0.0001) *
            (await Tokens.mainnetByAddr[repayAddr].uUnitsLoanedOutTo(userAddr));

          const ratio =
            (await PriceOracle.mainnet.getUnderlyingPrice(seizeAddr)) /
            (await PriceOracle.mainnet.getUnderlyingPrice(repayAddr));
          const seizeAmnt =
            (ratio *
              (await Tokens.mainnetByAddr[seizeAddr].uUnitsInContractFor(
                userAddr
              ))) /
            liqIncent;

          repayAmnt = Math.min(repayAmnt, seizeAmnt);

          if (repayAmnt == 0.0) {
            console.log(
              "Proposed repay=0, otherwise could've liquidated. Token pair likely stale"
            );
            return;
          }

          console.log("Liquidating " + userAddr);
          const tx = Tokens.mainnetByAddr[repayAddr].flashLiquidate_uUnits(
            userAddr,
            repayAmnt,
            seizeAddr,
            gasPrice *
              (target.profitability >= this._highRevenueThresh
                ? this._feeMaxMultiplier
                : this._feeMinMultiplier)
          );

          TxManager.shared.insert(tx, target.profitability);
          // TODO process.send(tx);
        }
      });
    }
  }

  onNewLiquidation(event) {
    if (event.liquidator == "0x6bfdfCC0169C3cFd7b5DC51c8E563063Df059097")
      return;
    const target = event.borrower;
    const targets = this._liquiCandidates.map(t => "0x" + t.address);

    if (!targets.includes(target)) {
      console.log(
        `Didn't liquidate ${target.slice(
          0,
          6
        )} because they weren't in the candidates list`
      );
    } else {
      console.warn(
        `Didn't liquidate ${target.slice(
          0,
          6
        )} based on JS logic (or lost gas bidding war)`
      );
      console.warn(event);
    }
  }
}

module.exports = Main;
