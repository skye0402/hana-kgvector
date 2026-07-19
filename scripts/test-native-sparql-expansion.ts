import { HanaNativeKnowledgeGraphStore } from "../src/native/hana-native-knowledge-graph-store";

const store = new HanaNativeKnowledgeGraphStore({} as any, { graphName: "TEST" }) as any;

const valuesExpansion = store.buildBoundedEntityExpansion("?seed", "?neighbor", 2, {
  seedValues: "<urn:test/a> <urn:test/b>",
});
const patternExpansion = store.buildBoundedEntityExpansion(
  "?seed",
  "?source",
  2,
  {
    seedPattern: "?chunk <urn:hkv:native:rel/DESCRIBES_ENTITY> ?seed .",
  }
);
const relationshipExpansion = store.buildBoundedEntityExpansion(
  "?seed",
  "?neighbor",
  2,
  {
    seedValues: "<urn:test/a>",
    suffixes: [
      "{{node}} ?predicate ?target . BIND({{node}} AS ?source)",
      "?source ?predicate {{node}} . BIND({{node}} AS ?target)",
    ],
  }
);
const chunkTripletExpansion = store.buildBoundedEntityExpansion(
  "?seed",
  "?source",
  1,
  {
    seedPattern: "?chunk <urn:hkv:native:rel/DESCRIBES_ENTITY> ?seed .",
    suffixes: ["{{node}} ?predicate ?target . BIND({{node}} AS ?source)"],
  }
);

function assertEveryBranchDefinesSeed(expansion: string, expectedSeedClause: string): void {
  const branches = expansion.split("\nUNION\n");
  if (branches.length < 2) {
    throw new Error(`Expected multiple UNION branches, got: ${expansion}`);
  }
  for (const branch of branches) {
    if (!branch.includes(expectedSeedClause)) {
      throw new Error(`Branch does not define ?seed: ${branch}`);
    }
  }
}

assertEveryBranchDefinesSeed(valuesExpansion, "VALUES ?seed");
assertEveryBranchDefinesSeed(patternExpansion, "DESCRIBES_ENTITY> ?seed");

if (relationshipExpansion.includes("?neighbor")) {
  throw new Error(`Expansion leaked branch-local temp variable ?neighbor: ${relationshipExpansion}`);
}

if (!chunkTripletExpansion.includes("BIND(?seed AS ?source)") || !chunkTripletExpansion.includes("BIND(?hop1_0 AS ?source)")) {
  throw new Error(`Chunk triplet expansion does not bind ?source in every branch: ${chunkTripletExpansion}`);
}

console.log("Native SPARQL expansion branches are self-contained.");
