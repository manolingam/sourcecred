// @flow

/**
 * In SourceCred, projects regularly distribute Grain to contributors based on
 * their Cred scores. This is called a "Harvest".
 *
 * This module contains the logic for calculating harvest amounts for
 * contributors. A harvest contains "receipts" showing how much Grain each
 * contributor will receive, the timestamp of the harvest in question, and the
 * "strategy" used to distribute grain.
 *
 * Currently we support two strategies:
 * - FAST, which distributes a fixed amount of grain based on the cred scores
 * in the most recent completed time interval
 * - FAIR, which distributes a fixed amount of grain based on cred scores
 * across
 * all time, prioritizing paying people who were under-paid historically (i.e.
 * their lifetime earnings are lower than we would expect given their current
 * cred score)
 *
 * In all cases, the timestamp for the harvest is used to determine which cred
 * scores are in scope. For example, if you create a fast harvest with a
 * timestamp in the past, it will reward people with cred in the past time
 * period, not the current one.
 */
import {sum} from "d3-array";
import {mapToArray} from "../util/map";
import {type NodeAddressT} from "../core/graph";
import {type Grain, multiplyFloat, ZERO} from "./grain";

export const HARVEST_VERSION_1 = 1;

export type HarvestStrategy = FastV1 | FairV1;

export type FastV1 = {|
  +type: "FAST",
  +version: number,
  +amount: Grain,
|};

export type FairV1 = {|
  +type: "FAIR",
  +version: number,
  +amount: Grain,
|};

export type GrainReceipt = {|+address: NodeAddressT, amount: Grain|};

export type HarvestV1 = {|
  +type: "HARVEST",
  +timestampMs: number,
  +version: number,
  +strategy: HarvestStrategy,
  +receipts: $ReadOnlyArray<GrainReceipt>,
|};

export type CredTimeSlice = {|
  +intervalEndMs: number,
  +cred: Map<NodeAddressT, number>,
|};

export type CredHistory = $ReadOnlyArray<CredTimeSlice>;

/**
 * Compute a full Harvest given:
 * - the strategy we're using
 * - the full cred history for all users
 * - the lifetime earnings of all users
 * - the timestamp for the harvest
 */
export function harvest(
  strategy: HarvestStrategy,
  credHistory: CredHistory,
  earnings: Map<NodeAddressT, Grain>,
  timestampMs: number
): HarvestV1 {
  const filteredSlices = credHistory.filter(
    (s) => s.intervalEndMs <= timestampMs
  );
  if (!filteredSlices.length) {
    return {
      type: "HARVEST",
      timestampMs,
      version: HARVEST_VERSION_1,
      strategy,
      receipts: [],
    };
  }

  const receipts: $ReadOnlyArray<GrainReceipt> = (function () {
    switch (strategy.type) {
      case "FAST":
        if (strategy.version !== 1) {
          throw new Error(`Unsupported FAST strategy: ${strategy.version}`);
        }
        const lastSlice = filteredSlices[filteredSlices.length - 1];
        return computeFastReceipts(strategy.amount, lastSlice.cred);
      case "FAIR":
        if (strategy.version !== 1) {
          throw new Error(`Unsupported FAIR strategy: ${strategy.version}`);
        }
        const totalCred = new Map();
        for (const {cred} of filteredSlices) {
          for (const [address, ownCred] of cred.entries()) {
            const existingCred = totalCred.get(address) || 0;
            totalCred.set(address, existingCred + ownCred);
          }
        }
        return computeFairReceipts(strategy.amount, totalCred, earnings);
      default:
        throw new Error(`Unexpected type ${(strategy.type: empty)}`);
    }
  })();

  return {
    type: "HARVEST",
    version: HARVEST_VERSION_1,
    strategy,
    receipts,
    timestampMs,
  };
}

/**
 * Split a grain amount in proportion to the provided scores
 */
function computeFastReceipts(
  harvestAmount: Grain,
  cred: Map<NodeAddressT, number>
): $ReadOnlyArray<GrainReceipt> {
  if (harvestAmount < ZERO) {
    throw new Error(`invalid harvestAmount: ${String(harvestAmount)}`);
  }

  const totalCred = sum(cred.values());
  if (totalCred === 0) {
    return [];
  }

  return mapToArray(cred, ([address, cred]) => ({
    address,
    amount: multiplyFloat(harvestAmount, cred / totalCred),
  }));
}

/**
 * Distribute a fixed amount of Grain to the users who were "most underpaid".
 *
 * We consider a user underpaid if they have recieved a smaller proportion of
 * past earnings than their share of score. They are fairly paid if their
 * proportion of earnings is equal to their score share, and they are overpaid
 * if their proportion of earnings is higher than their share of the score.
 *
 * We start by imagining a hypothetical world, where the entire grain supply of
 * the project (including this harvest) were distributed according to the
 * current scores. Based on this, we can calculate the "fair" lifetime earnings
 * for each participant. Usually, some will be "underpaid" (they recieved less
 * than this amount) and others are "overpaid".
 *
 * We can sum across all users who were underpaid to find the "total
 * underpayment". As an invariant, `totalUnderpayment = harvestAmount +
 * totalOverpayment`, since no-one has yet been paid the harvestAmount, and
 * beyond that every grain of overpayment to one actor is underpayment for a
 * different actor.
 *
 * Now that we've calculated each actor's underpayment, and the total
 * underpayment, we divide the harvest's grain amount across users in
 * proportion to their underpayment.
 *
 * You should use this harvest when you want to divide a fixed amount of grain
 * across participants in a way that aligns long-term payment with total cred
 * scores.
 */
function computeFairReceipts(
  harvestAmount: Grain,
  credMap: Map<NodeAddressT, number>,
  earnings: Map<NodeAddressT, Grain>
): $ReadOnlyArray<GrainReceipt> {
  if (harvestAmount < ZERO) {
    throw new Error(`invalid harvestAmount: ${String(harvestAmount)}`);
  }

  let totalEarnings = ZERO;
  for (const e of earnings.values()) {
    totalEarnings += e;
  }
  let totalCred = 0;
  for (const s of credMap.values()) {
    totalCred += s;
  }
  if (totalCred === 0) {
    return [];
  }

  const targetGrainPerCred = multiplyFloat(
    totalEarnings + harvestAmount,
    1 / totalCred
  );

  let totalUnderpayment = ZERO;
  const userUnderpayment: Map<NodeAddressT, Grain> = new Map();
  const addresses = new Set([...credMap.keys(), ...earnings.keys()]);

  for (const addr of addresses) {
    const earned = earnings.get(addr) || ZERO;
    const cred = credMap.get(addr) || 0;

    const target = multiplyFloat(targetGrainPerCred, cred);
    if (target > earned) {
      const underpayment = target - earned;
      userUnderpayment.set(addr, underpayment);
      totalUnderpayment += underpayment;
    }
  }

  return mapToArray(userUnderpayment, ([address, underpayment]) => {
    const underpaymentProportion =
      Number(underpayment) / Number(totalUnderpayment);
    return {
      address,
      amount: multiplyFloat(harvestAmount, underpaymentProportion),
    };
  });
}
