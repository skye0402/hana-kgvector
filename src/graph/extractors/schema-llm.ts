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
Try to limit to {maxTriplets} extracted paths.

Schema:
- Entity types: {entityTypes}
- Relation types: {relationTypes}
- Valid relationships: {validationSchema}

Text:
-------
{text}
-------

Extract entities and relationships from the text above.`;

export class SchemaLLMPathExtractor implements TransformComponent {
  private readonly llm: LLMClient;
  private readonly schema: SchemaDefinition;
  private readonly maxTripletsPerChunk: number;
  private readonly strict: boolean;
  private readonly extractPromptTemplate: string;
  private readonly tripletSchema: z.ZodType<any>;

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

    return this.schema.validationSchema.some(
      ([s, r, o]) =>
        s.toUpperCase() === subjectType.toUpperCase() &&
        r.toUpperCase() === relationType.toUpperCase() &&
        o.toUpperCase() === objectType.toUpperCase()
    );
  }

  private pruneInvalidTriplets(
    extracted: { triplets: Array<{ subject: any; relation: any; object: any }> }
  ): Triplet[] {
    const validTriplets: Triplet[] = [];

    for (const triplet of extracted.triplets) {
      const subjectType = String(triplet.subject.type).toUpperCase().replace(/\s+/g, "_");
      const relationType = String(triplet.relation.type).toUpperCase().replace(/\s+/g, "_");
      const objectType = String(triplet.object.type).toUpperCase().replace(/\s+/g, "_");

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
      const result = await this.llm.structuredPredict(this.tripletSchema, prompt);
      triplets = this.pruneInvalidTriplets(result);
    } catch {
      triplets = [];
    }

    const existingNodes = (node.metadata[KG_NODES_KEY] as EntityNode[]) ?? [];
    const existingRelations = (node.metadata[KG_RELATIONS_KEY] as Relation[]) ?? [];

    for (const [subj, rel, obj] of triplets) {
      subj.properties = { ...subj.properties, ...node.metadata };
      obj.properties = { ...obj.properties, ...node.metadata };
      rel.properties = { ...rel.properties, ...node.metadata };

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
