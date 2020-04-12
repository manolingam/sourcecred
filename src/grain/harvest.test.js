// @flow

import {NodeAddress} from "../core/graph";
import {ONE, ZERO, fromApproximateFloat, format} from "./grain";
import {HARVEST_VERSION_1, harvest} from "./harvest";
import deepFreeze from "deep-freeze";
import type {
  CredHistory,
  FairV1,
  FastV1,
  GrainReceipt,
  HarvestStrategy,
  HarvestV1,
} from "./harvest";
import type {Grain} from "./grain";

describe("src/grain/harvest", () => {
  const foo = NodeAddress.fromParts(["foo"]);
  const bar = NodeAddress.fromParts(["bar"]);

  const timestampMs = 1000;

  const credHistory: CredHistory = deepFreeze([
    {
      intervalEndMs: 10,
      cred: new Map([
        [foo, 9],
        [bar, 1],
      ]),
    },
    {
      intervalEndMs: 20,
      cred: new Map([
        [foo, 1],
        [bar, 1],
      ]),
    },
    {intervalEndMs: 30, cred: new Map([[bar, 2]])},
  ]);
  function fmt(g: Grain) {
    return format(g, 3);
  }
  function safeReceipts(receipts: $ReadOnlyArray<GrainReceipt>) {
    return receipts.map(({address, amount}) => ({
      address,
      amount: fmt(amount),
    }));
  }
  function safeStrategy(strat: HarvestStrategy) {
    return {...strat, amount: fmt(strat.amount)};
  }
  function safeHarvest(harvest: HarvestV1) {
    return {
      ...harvest,
      strategy: safeStrategy(harvest.strategy),
      receipts: safeReceipts(harvest.receipts),
    };
  }
  function expectHarvestsEqual(h1, h2) {
    expect(safeHarvest(h1)).toEqual(safeHarvest(h2));
  }

  describe("fastHarvest", () => {
    const strategy: FastV1 = deepFreeze({
      type: "FAST",
      amount: ONE,
      version: 1,
    });

    describe("it should return an empty harvest when", () => {
      const emptyHarvest = deepFreeze({
        type: "HARVEST",
        version: HARVEST_VERSION_1,
        receipts: [],
        strategy,
        timestampMs,
      });

      it("there are no cred scores at all", () => {
        const actual = harvest(strategy, [], new Map(), timestampMs);

        expectHarvestsEqual(actual, emptyHarvest);
      });

      it("all cred scores are from the future", () => {
        const actual = harvest(strategy, credHistory, new Map(), 0);
        expectHarvestsEqual(actual, {...emptyHarvest, timestampMs: 0});
      });

      it("all the cred sums to 0", () => {
        const actual = harvest(
          strategy,
          [
            {
              intervalEndMs: timestampMs - 500,
              cred: new Map([
                [foo, 0],
                [bar, 0],
              ]),
            },
          ],
          new Map(),
          timestampMs
        );

        expectHarvestsEqual(actual, emptyHarvest);
      });
    });

    const createFastHarvest = (
      timestampMs: number,
      receipts: $ReadOnlyArray<GrainReceipt>
    ) => {
      return {
        type: "HARVEST",
        version: HARVEST_VERSION_1,
        receipts,
        strategy,
        timestampMs,
      };
    };

    it("throws an error if given an unsupported strategy", () => {
      const unsupportedStrategy = {
        ...strategy,
        version: 2,
      };
      expect(() =>
        harvest(unsupportedStrategy, credHistory, new Map(), timestampMs)
      ).toThrowError(`Unsupported FAST strategy: 2`);
    });
    it("handles an interval in the middle", () => {
      const result = harvest(strategy, credHistory, new Map(), 20);
      // $ExpectFlowError
      const HALF = ONE / 2n;
      const expectedReceipts = [
        {address: foo, amount: HALF},
        {address: bar, amount: HALF},
      ];
      const expectedHarvest = createFastHarvest(20, expectedReceipts);
      expectHarvestsEqual(result, expectedHarvest);
    });
    it("handles an interval with un-even cred distribution", () => {
      const result = harvest(strategy, credHistory, new Map(), 12);
      // $ExpectFlowError
      const ONE_TENTH = ONE / 10n;
      const NINE_TENTHS = ONE - ONE_TENTH;
      const expectedReceipts = [
        {address: foo, amount: NINE_TENTHS},
        {address: bar, amount: ONE_TENTH},
      ];
      const expectedHarvest = createFastHarvest(12, expectedReceipts);
      expectHarvestsEqual(result, expectedHarvest);
    });
    it("handles an interval at the end", () => {
      const result = harvest(strategy, credHistory, new Map(), 1000);
      const expectedReceipts = [{address: bar, amount: ONE}];
      const expectedHarvest = createFastHarvest(1000, expectedReceipts);
      expectHarvestsEqual(result, expectedHarvest);
    });
  });

  describe("fairHarvest", () => {
    const strategy = deepFreeze({
      type: "FAIR",
      amount: fromApproximateFloat(14),
      version: 1,
    });

    const createFairHarvest = (
      timestampMs: number,
      receipts: $ReadOnlyArray<GrainReceipt>,
      strategy: FairV1
    ) => {
      return {
        type: "HARVEST",
        version: HARVEST_VERSION_1,
        receipts,
        strategy,
        timestampMs,
      };
    };

    describe("it should return an empty harvest when", () => {
      const emptyHarvest = deepFreeze({
        type: "HARVEST",
        version: HARVEST_VERSION_1,
        receipts: [],
        strategy,
        timestampMs,
      });

      it("there are no cred scores at all", () => {
        const actual = harvest(strategy, [], new Map(), timestampMs);

        expectHarvestsEqual(actual, emptyHarvest);
      });

      it("all cred scores are from the future", () => {
        const actual = harvest(strategy, credHistory, new Map(), 0);
        expectHarvestsEqual(actual, {...emptyHarvest, timestampMs: 0});
      });

      it("all the cred sums to 0", () => {
        const actual = harvest(
          strategy,
          [
            {
              intervalEndMs: timestampMs - 500,
              cred: new Map([
                [foo, 0],
                [bar, 0],
              ]),
            },
          ],
          new Map(),
          timestampMs
        );

        expectHarvestsEqual(actual, emptyHarvest);
      });
    });

    it("throws an error if given an unsupported strategy", () => {
      const unsupportedStrategy = {
        ...strategy,
        version: 2,
      };
      expect(() =>
        harvest(unsupportedStrategy, credHistory, new Map(), timestampMs)
      ).toThrowError(`Unsupported FAIR strategy: 2`);
    });

    it("should only pay Foo if Foo is sufficiently underpaid", () => {
      const earnings = new Map([
        [foo, ZERO],
        [bar, fromApproximateFloat(99)],
      ]);
      const expectedReceipts = [
        {address: foo, amount: fromApproximateFloat(14)},
      ];
      const expectedHarvest = createFairHarvest(
        timestampMs,
        expectedReceipts,
        strategy
      );
      const actual = harvest(strategy, credHistory, earnings, timestampMs);
      expectHarvestsEqual(expectedHarvest, actual);
    });
    it("should divide according to cred if everyone is already fairly paid", () => {
      const earnings = new Map([
        [foo, fromApproximateFloat(5)],
        [bar, fromApproximateFloat(2)],
      ]);

      const expectedReceipts = [
        {address: foo, amount: fromApproximateFloat(10)},
        {address: bar, amount: fromApproximateFloat(4)},
      ];

      const expectedHarvest = createFairHarvest(
        timestampMs,
        expectedReceipts,
        strategy
      );

      const actual = harvest(strategy, credHistory, earnings, timestampMs);
      expectHarvestsEqual(expectedHarvest, actual);
    });
    it("'top off' users who were slightly underpaid'", () => {
      // Foo is exactly 1 grain behind where they "should" be
      const earnings = new Map([
        [foo, fromApproximateFloat(4)],
        [bar, fromApproximateFloat(2)],
      ]);

      const strategy15 = {...strategy, amount: fromApproximateFloat(15)};

      const expectedReceipts = [
        {address: foo, amount: fromApproximateFloat(11)},
        {address: bar, amount: fromApproximateFloat(4)},
      ];

      const expectedHarvest = createFairHarvest(
        timestampMs,
        expectedReceipts,
        strategy15
      );

      const actual = harvest(strategy15, credHistory, earnings, timestampMs);
      expectHarvestsEqual(expectedHarvest, actual);
    });
    it("should ignore cred scores from the future", () => {
      const middleTimes = 29;

      const strategy12 = {...strategy, amount: fromApproximateFloat(12)};

      // In the last time slice, foo gets 0 cred and bar gets 2
      const expectedReceipts = [
        {address: foo, amount: fromApproximateFloat(10)},
        {address: bar, amount: fromApproximateFloat(2)},
      ];

      const expectedHarvest = createFairHarvest(
        middleTimes,
        expectedReceipts,
        strategy12
      );

      const actual = harvest(strategy12, credHistory, new Map(), middleTimes);
      expectHarvestsEqual(expectedHarvest, actual);
    });
    it("should handle the case where one user has no historical earnings", () => {
      const earnings = new Map([[foo, fromApproximateFloat(5)]]);

      const expectedReceipts = [
        {address: bar, amount: fromApproximateFloat(2)},
      ];
      const strategy2 = {...strategy, amount: fromApproximateFloat(2)};

      const expectedHarvest = createFairHarvest(
        timestampMs,
        expectedReceipts,
        strategy2
      );

      const actual = harvest(strategy2, credHistory, earnings, timestampMs);
      expectHarvestsEqual(expectedHarvest, actual);
    });
    it("should not break if a user has earnings but no cred", () => {
      const earnings = new Map([
        [NodeAddress.fromParts(["zoink"]), fromApproximateFloat(10)],
      ]);

      const expectedReceipts = [
        {address: foo, amount: fromApproximateFloat(10)},
        {address: bar, amount: fromApproximateFloat(4)},
      ];

      const expectedHarvest = createFairHarvest(
        timestampMs,
        expectedReceipts,
        strategy
      );

      const actual = harvest(strategy, credHistory, earnings, timestampMs);
      expectHarvestsEqual(expectedHarvest, actual);
    });
  });
});
