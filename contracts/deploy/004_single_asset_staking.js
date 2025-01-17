//
// Script to deploy the Single Asset Staking contract.
//
const {
  getAssetAddresses,
  isMainnet,
  isFork,
  isTest,
  isMainnetOrFork,
} = require("../test/helpers.js");
const { utils } = require("ethers");
const {
  log,
  deployWithConfirmation,
  withConfirmation,
  executeProposal,
} = require("../utils/deploy");
const { proposeArgs } = require("../utils/governor");

const deployName = "004_single_asset_staking";

const singleAssetStaking = async ({ getNamedAccounts, deployments }) => {
  console.log(`Running ${deployName} deployment...`);

  const { governorAddr, deployerAddr } = await getNamedAccounts();

  const assetAddresses = await getAssetAddresses(deployments);

  const sDeployer = ethers.provider.getSigner(deployerAddr);
  const sGovernor = ethers.provider.getSigner(governorAddr);

  //
  // Deploy the contracts.
  //
  await deployWithConfirmation(
    "OGNStakingProxy",
    [],
    "InitializeGovernedUpgradeabilityProxy"
  );
  const dSingleAssetStaking = await deployWithConfirmation(
    "SingleAssetStaking"
  );

  //
  // Initialize the contracts.
  //

  // Initialize the proxy.
  const cOGNStakingProxy = await ethers.getContract("OGNStakingProxy");
  await withConfirmation(
    cOGNStakingProxy["initialize(address,address,bytes)"](
      dSingleAssetStaking.address,
      deployerAddr,
      []
    )
  );
  log("Initialized OGNStakingProxy");

  // Initialize the SingleAssetStaking contract.
  const cOGNStaking = await ethers.getContractAt(
    "SingleAssetStaking",
    cOGNStakingProxy.address
  );

  const minute = 60;
  const day = 24 * 60 * minute;
  let durations, rates;
  if (isMainnet) {
    // Staking durations are 30 days, 90 days, 365 days
    durations = [30 * day, 90 * day, 365 * day];
    rates = [
      utils.parseUnits("0.00616438", 18),
      utils.parseUnits("0.03082192", 18),
      utils.parseUnits("0.25", 18),
    ];
  } else if (isTest) {
    durations = [90 * day, 180 * day, 360 * day];
    rates = [
      utils.parseUnits("0.085", 18),
      utils.parseUnits("0.145", 18),
      utils.parseUnits("0.30", 18),
    ];
  } else {
    // localhost or ganacheFork need a shorter stake for testing purposes.
    // Add a very quick vesting rate ideal for testing (10 minutes).
    durations = [30 * day, 4 * minute, 365 * day];
    rates = [
      utils.parseUnits("0.00616438", 18),
      utils.parseUnits("15000", 18),
      utils.parseUnits("0.25", 18),
    ];
  }
  log(`OGN Asset address: ${assetAddresses.OGN}`);
  await withConfirmation(
    cOGNStaking
      .connect(sDeployer)
      .initialize(assetAddresses.OGN, durations, rates)
  );
  log("Initialized OGNStaking");

  //
  // Initialize the OGN compensation data.
  //

  // The Merkle root hash is generated by the scripts/staking/airDrop.js
  // We set the hash for testing. For Mainnet it will get set later via
  // a governance call once the compensation numbers are finalized
  // and the compensation program is ready to get started.
  let dropRootHash, dropProofDepth;
  if (!isMainnet) {
    if (process.env.DROP_ROOT_HASH && process.env.DROP_PROOF_DEPTH) {
      // If a root hash and depth were specified as env vars, use that.
      dropRootHash = process.env.DROP_ROOT_HASH;
      dropProofDepth = process.env.DROP_PROOF_DEPTH;
    } else {
      // use testing generated scripts
      const { computeRootHash } = require("../utils/stake");
      const testPayouts = require("../scripts/staking/rawAccountsToBeCompensated.json");
      const root = await computeRootHash(cOGNStaking.address, testPayouts);
      dropRootHash = root.hash;
      dropProofDepth = root.depth;
    }

    const stakeType = 1; // 1 is the first drop type
    await withConfirmation(
      cOGNStaking
        .connect(sDeployer)
        .setAirDropRoot(stakeType, dropRootHash, dropProofDepth)
    );

    log(`Merkle root hash set to ${dropRootHash}`);
    log(`Merkle proof depth set to ${dropProofDepth}`);
  } else {
    log("Mainnet: Merkle tree not initialized.");
  }

  //
  // Transfer governance of the proxy to the governor.
  //
  await withConfirmation(
    cOGNStaking.connect(sDeployer).transferGovernance(governorAddr)
  );
  log(`OGNStaking transferGovernance(${governorAddr}) called`);

  const propDescription = "OGNStaking governor change";
  const propArgs = await proposeArgs([
    {
      contract: cOGNStaking,
      signature: "claimGovernance()",
    },
  ]);

  if (isMainnet) {
    // On Mainnet claiming governance has to be handled manually via a multi-sig tx.
    log(
      "Next step: propose, enqueue and execute a governance proposal to claim governance."
    );
    log(`Governor address: ${governorAddr}`);
    log(`Proposal [targets, values, sigs, datas]:`);
    log(JSON.stringify(propArgs, null, 2));
  } else if (isFork) {
    // On Fork, simulate the governance proposal and execution flow that takes place on Mainnet.
    await executeProposal(propArgs, propDescription);
  } else {
    // Local testing environment. Claim governance via the governor account directly.
    await cOGNStaking.connect(sGovernor).claimGovernance();
    log("Claimed governance");
  }

  //
  // Fund the staking contract with OGN to cover rewards.
  //
  if (!isMainnetOrFork) {
    const ogn = await ethers.getContract("MockOGN");
    // Amount to load in for rewards
    // Put in a small amount so that we can hit limits for testing
    const loadAmount = utils.parseUnits("299", 18);
    await ogn.connect(sDeployer).addCallSpenderWhitelist(cOGNStaking.address);
    await ogn.connect(sGovernor).mint(loadAmount);
    await ogn.connect(sGovernor).transfer(cOGNStaking.address, loadAmount);
    log("Funded staking contract with some OGN");
  } else {
    log(
      `Next step: fund the staking contract at ${cOGNStaking.address} with OGN`
    );
  }

  console.log(`${deployName} deploy done.`);
  return true;
};

singleAssetStaking.id = deployName;
singleAssetStaking.dependencies = ["core"];
singleAssetStaking.skip = () => isFork;

module.exports = singleAssetStaking;
