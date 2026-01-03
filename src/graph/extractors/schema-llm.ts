import { z } from "zod";
import type { TransformComponent, TextNode, SchemaDefinition } from "./types";
import type { EntityNode, Relation, Triplet } from "../types";
import { KG_NODES_KEY, KG_RELATIONS_KEY, createEntityNode, createRelation } from "../types";

export interface LLMClient {
  structuredPredict<T>(schema: z.ZodType<T>, prompt: string): Promise<T>;
}

export interface SchemaLLMPathExtractorOptions {
  llm: LLMClient;
  schema: SchemaDefinition;
  maxTripletsPerChunk?: number;
  strict?: boolean;
  extractPromptTemplate?: string;
}

const DEFAULT_EXTRACT_PROMPT = `Given the following text, extract a knowledge graph according to the provided schema.
Extract up to {maxTriplets} triplets. If fewer are present in the text, return fewer. Do not invent or pad triplets.

Schema:
- Entity types: {entityTypes}
- Relation types: {relationTypes}
- Valid relationships: {validationSchema}

Text:
-------
{text}
-------

Extract entities and relationships from the text above.
Return your answer as a JSON object with a "triplets" array. Each triplet should have:
- "subject": { "name": string, "type": one of [{entityTypes}] }
- "relation": { "type": one of [{relationTypes}] }
- "object": { "name": string, "type": one of [{entityTypes}] }

Example output format:
{
  "triplets": [
    {
      "subject": { "name": "John", "type": "PERSON" },
      "relation": { "type": "WORKS_AT" },
      "object": { "name": "Acme Corp", "type": "ORGANIZATION" }
    }
  ]
}`;

export class SchemaLLMPathExtractor implements TransformComponent {
  private readonly llm: LLMClient;
  private readonly schema: SchemaDefinition;
  private readonly maxTripletsPerChunk: number;
  private readonly strict: boolean;
  private readonly extractPromptTemplate: string;
  private readonly tripletSchema: z.ZodType<any>;
  private readonly rawTripletSchema: z.ZodType<any>;

  constructor(options: SchemaLLMPathExtractorOptions) {
    this.llm = options.llm;
    this.schema = options.schema;
    this.maxTripletsPerChunk = options.maxTripletsPerChunk ?? 10;
    this.strict = options.strict ?? true;
    this.extractPromptTemplate = options.extractPromptTemplate ?? DEFAULT_EXTRACT_PROMPT;

    const entityTypeEnum = z.enum(this.schema.entityTypes as [string, ...string[]]);
    const relationTypeEnum = z.enum(this.schema.relationTypes as [string, ...string[]]);

    const entitySchema = z.object({
      name: z.string(),
      type: entityTypeEnum,
      properties: z.record(z.unknown()).optional(),
    });

    const relationSchema = z.object({
      type: relationTypeEnum,
      properties: z.record(z.unknown()).optional(),
    });

    const tripletSchema = z.object({
      subject: entitySchema,
      relation: relationSchema,
      object: entitySchema,
    });

    this.tripletSchema = z.object({
      triplets: z.array(tripletSchema),
    });

    this.rawTripletSchema = z.object({
      triplets: z.array(z.any()),
    });
  }

  private normalizeType(type: string): string {
    return String(type).toUpperCase().replace(/\s+/g, "_");
  }

  private buildPrompt(text: string): string {
    const validationSchemaStr = this.schema.validationSchema
      ?.map(([s, r, o]) => `(${s})-[${r}]->(${o})`)
      .join(", ") ?? "Any valid combination";

    return this.extractPromptTemplate
      .replace("{maxTriplets}", String(this.maxTripletsPerChunk))
      .replace("{entityTypes}", this.schema.entityTypes.join(", "))
      .replace("{relationTypes}", this.schema.relationTypes.join(", "))
      .replace("{validationSchema}", validationSchemaStr)
      .replace("{text}", text);
  }

  private isValidTriplet(subjectType: string, relationType: string, objectType: string): boolean {
    if (!this.strict || !this.schema.validationSchema) {
      return true;
    }

    const subj = this.normalizeType(subjectType);
    const rel = this.normalizeType(relationType);
    const obj = this.normalizeType(objectType);

    return this.schema.validationSchema.some(
      ([s, r, o]) =>
        this.normalizeType(s) === subj &&
        this.normalizeType(r) === rel &&
        this.normalizeType(o) === obj
    );
  }

  private pruneInvalidTriplets(
    extracted: { triplets: Array<{ subject: any; relation: any; object: any }> }
  ): Triplet[] {
    const validTriplets: Triplet[] = [];

    const allowedEntityTypes = new Set(this.schema.entityTypes.map((t) => this.normalizeType(t)));
    const allowedRelationTypes = new Set(this.schema.relationTypes.map((t) => this.normalizeType(t)));

    for (const triplet of extracted.triplets) {
      const subject = (triplet as any)?.subject;
      const relation = (triplet as any)?.relation;
      const object = (triplet as any)?.object;

      if (!subject || !relation || !object) continue;
      if (typeof subject.type !== "string" || typeof subject.name !== "string") continue;
      if (typeof relation.type !== "string") continue;
      if (typeof object.type !== "string" || typeof object.name !== "string") continue;

      const subjectType = this.normalizeType(subject.type);
      const relationType = this.normalizeType(relation.type);
      const objectType = this.normalizeType(object.type);

      if (this.strict) {
        if (!allowedEntityTypes.has(subjectType)) continue;
        if (!allowedRelationTypes.has(relationType)) continue;
        if (!allowedEntityTypes.has(objectType)) continue;
      }

      if (!this.isValidTriplet(subjectType, relationType, objectType)) {
        continue;
      }

      const subjectName = String(triplet.subject.name).trim();
      const objectName = String(triplet.object.name).trim();

      if (subjectName.toLowerCase() === objectName.toLowerCase()) {
        continue;
      }

      const subj = createEntityNode({
        label: subjectType,
        name: subjectName,
        properties: triplet.subject.properties ?? {},
      });

      const obj = createEntityNode({
        label: objectType,
        name: objectName,
        properties: triplet.object.properties ?? {},
      });

      const rel = createRelation({
        label: relationType,
        sourceId: subj.id,
        targetId: obj.id,
        properties: triplet.relation.properties ?? {},
      });

      validTriplets.push([subj, rel, obj]);
    }

    return validTriplets;
  }

  private async extractFromNode(node: TextNode): Promise<TextNode> {
    const prompt = this.buildPrompt(node.text);

    let triplets: Triplet[] = [];

    try {
      const result = await this.llm.structuredPredict(this.rawTripletSchema, prompt);
      triplets = this.pruneInvalidTriplets(result);

      if (this.maxTripletsPerChunk > 0 && triplets.length > this.maxTripletsPerChunk) {
        triplets = triplets.slice(0, this.maxTripletsPerChunk);
      }
    } catch (err) {
      // Log extraction errors for debugging
      console.warn(`[SchemaLLMPathExtractor] Failed to extract from node ${node.id}:`, err);
      triplets = [];
    }

    const existingNodes = (node.metadata[KG_NODES_KEY] as EntityNode[]) ?? [];
    const existingRelations = (node.metadata[KG_RELATIONS_KEY] as Relation[]) ?? [];

    // Avoid copying kg_nodes/kg_relations into node properties (can create circular refs)
    const safeMetadata: Record<string, unknown> = { ...node.metadata };
    delete safeMetadata[KG_NODES_KEY];
    delete safeMetadata[KG_RELATIONS_KEY];

    for (const [subj, rel, obj] of triplets) {
      subj.properties = { ...subj.properties, ...safeMetadata };
      obj.properties = { ...obj.properties, ...safeMetadata };
      rel.properties = { ...rel.properties, ...safeMetadata };

      existingNodes.push(subj);
      existingNodes.push(obj);
      existingRelations.push(rel);
    }

    return {
      ...node,
      metadata: {
        ...node.metadata,
        [KG_NODES_KEY]: existingNodes,
        [KG_RELATIONS_KEY]: existingRelations,
      },
    };
  }

  async transform(nodes: TextNode[], options?: { showProgress?: boolean }): Promise<TextNode[]> {
    const results: TextNode[] = [];

    for (const node of nodes) {
      const processed = await this.extractFromNode(node);
      results.push(processed);
    }

    return results;
  }
}
