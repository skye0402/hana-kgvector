import type { HanaConnection } from "../hana/types";
import type { EntityNode, Relation, Triplet } from "../graph/types";
import { KG_SOURCE_REL, TRIPLET_SOURCE_KEY } from "../graph/types";
import { escapeSparqlLiteral, escapeSqlStringLiteral, safeJsonParse } from "./util";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const HKV = "urn:hkv:native:";

export class HanaNativeKnowledgeGraphStore {
  private readonly conn: HanaConnection;
  readonly graphName: string;
  private readonly resetGraph: boolean;
  private initialized = false;

  constructor(conn: HanaConnection, options: { graphName: string; resetGraph?: boolean }) {
    this.conn = conn;
    this.graphName = options.graphName;
    this.resetGraph = options.resetGraph ?? false;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.resetGraph) {
      await this.clear();
    }
    this.initialized = true;
  }

  async upsertEntities(entities: EntityNode[]): Promise<void> {
    await this.initialize();
    if (entities.length === 0) return;

    const lines: string[] = [];
    const seen = new Set<string>();
    for (const entity of entities) {
      if (seen.has(entity.id)) continue;
      seen.add(entity.id);
      lines.push(...this.entityTriples(entity));
    }

    await this.insertTriples(lines);
  }

  async upsertRelations(relations: Relation[], entityById: Map<string, EntityNode>): Promise<void> {
    await this.initialize();
    if (relations.length === 0) return;

    const lines: string[] = [];
    const seen = new Set<string>();
    for (const relation of relations) {
      const id = relation.id ?? `${relation.sourceId}_${relation.label}_${relation.targetId}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const source = entityById.get(relation.sourceId);
      const target = entityById.get(relation.targetId);
      if (!source || !target) continue;

      lines.push(...this.relationTriples({ ...relation, id }, source, target));
    }

    await this.insertTriples(lines);
  }

  async linkChunks(chunks: Array<{ id: string; metadata: Record<string, unknown> }>, entities: EntityNode[]): Promise<void> {
    await this.initialize();
    if (chunks.length === 0 || entities.length === 0) return;

    const entitiesBySource = new Map<string, EntityNode[]>();
    for (const entity of entities) {
      const source = entity.properties?.[TRIPLET_SOURCE_KEY] ?? entity.properties?.source_object ?? entity.properties?.objectName;
      if (!source) continue;
      const key = String(source).toLowerCase();
      const bucket = entitiesBySource.get(key) ?? [];
      bucket.push(entity);
      entitiesBySource.set(key, bucket);
    }

    const lines: string[] = [];
    for (const chunk of chunks) {
      const chunkUri = this.chunkUri(chunk.id);
      lines.push(`${chunkUri} <${RDF_TYPE}> <${HKV}type/CHUNK> .`);
      lines.push(`${chunkUri} <${HKV}prop/id> "${escapeSparqlLiteral(chunk.id)}" .`);

      const objectName = chunk.metadata.objectName ?? chunk.metadata.object_name;
      if (!objectName) continue;

      const candidates = entitiesBySource.get(String(objectName).toLowerCase()) ?? [];
      for (const entity of candidates) {
        lines.push(`${this.entityUri(entity)} <${HKV}rel/HAS_SOURCE_CHUNK> ${chunkUri} .`);
        lines.push(`${chunkUri} <${HKV}rel/DESCRIBES_ENTITY> ${this.entityUri(entity)} .`);
      }
    }

    await this.insertTriples(lines);
  }

  async getEntities(entityType?: string): Promise<EntityNode[]> {
    const typeFilter = entityType ? `?entity <${HKV}prop/label> "${escapeSparqlLiteral(entityType)}" .` : "";
    const rows = await this.sparqlTable(`
      SELECT ?entity ?id ?label ?name ?properties
      FROM <${this.graphName}>
      WHERE {
        ?entity <${RDF_TYPE}> <${HKV}type/ENTITY> .
        ?entity <${HKV}prop/id> ?id .
        ?entity <${HKV}prop/label> ?label .
        ?entity <${HKV}prop/name> ?name .
        OPTIONAL { ?entity <${HKV}prop/propertiesJson> ?properties . }
        ${typeFilter}
      }
      ORDER BY ?label ?name
    `);

    return (rows ?? []).map((row) => this.rowToEntity(row));
  }

  async findEntitiesByName(name: string): Promise<EntityNode[]> {
    const rows = await this.sparqlTable(`
      SELECT ?entity ?id ?label ?name ?properties
      FROM <${this.graphName}>
      WHERE {
        ?entity <${RDF_TYPE}> <${HKV}type/ENTITY> .
        ?entity <${HKV}prop/id> ?id .
        ?entity <${HKV}prop/label> ?label .
        ?entity <${HKV}prop/name> ?name .
        OPTIONAL { ?entity <${HKV}prop/propertiesJson> ?properties . }
        FILTER(LCASE(STR(?name)) = "${escapeSparqlLiteral(name.toLowerCase())}")
      }
    `);

    return (rows ?? []).map((row) => this.rowToEntity(row));
  }

  async getRelationships(options: {
    seedEntities: EntityNode[];
    relType?: string;
    depth?: number;
    limit?: number;
  }): Promise<Array<{ source: EntityNode; relation: Relation; target: EntityNode }>> {
    if (options.seedEntities.length === 0) return [];

    const depth = Math.max(1, options.depth ?? 1);
    const limit = options.limit ?? 100;
    const seedValues = options.seedEntities.map((entity) => this.entityUri(entity)).join(" ");
    const relFilter = options.relType ? `?rel <${HKV}prop/label> "${escapeSparqlLiteral(options.relType)}" .` : "";
    const path = `VALUES ?seed { ${seedValues} }
      ${this.buildBoundedEntityExpansion("?seed", "?neighbor", depth)}
      { BIND(?neighbor AS ?source) ?source ?predicate ?target . }
      UNION
      { BIND(?neighbor AS ?target) ?source ?predicate ?target . }`;

    const rows = await this.sparqlTable(`
      SELECT ?source ?sourceId ?sourceLabel ?sourceName ?sourceProps
             ?predicate ?rel ?relId ?relLabel ?relProps
             ?target ?targetId ?targetLabel ?targetName ?targetProps
      FROM <${this.graphName}>
      WHERE {
        ${path}
        ?source <${RDF_TYPE}> <${HKV}type/ENTITY> .
        ?target <${RDF_TYPE}> <${HKV}type/ENTITY> .
        ?source <${HKV}prop/id> ?sourceId ; <${HKV}prop/label> ?sourceLabel ; <${HKV}prop/name> ?sourceName .
        ?target <${HKV}prop/id> ?targetId ; <${HKV}prop/label> ?targetLabel ; <${HKV}prop/name> ?targetName .
        OPTIONAL { ?source <${HKV}prop/propertiesJson> ?sourceProps . }
        OPTIONAL { ?target <${HKV}prop/propertiesJson> ?targetProps . }
        ?rel <${RDF_TYPE}> <${HKV}type/RELATION> .
        ?rel <${HKV}prop/sourceId> ?sourceId .
        ?rel <${HKV}prop/targetId> ?targetId .
        ?rel <${HKV}prop/id> ?relId .
        ?rel <${HKV}prop/label> ?relLabel .
        OPTIONAL { ?rel <${HKV}prop/propertiesJson> ?relProps . }
        ${relFilter}
        FILTER(STRSTARTS(STR(?predicate), "${HKV}rel/"))
        FILTER(?predicate != <${HKV}rel/CONNECTED_TO>)
        FILTER(?predicate != <${HKV}rel/HAS_SOURCE_CHUNK>)
        FILTER(?predicate != <${HKV}rel/DESCRIBES_ENTITY>)
      }
      LIMIT ${limit}
    `);

    const seen = new Set<string>();
    const results: Array<{ source: EntityNode; relation: Relation; target: EntityNode }> = [];
    for (const row of rows ?? []) {
      const source = this.rowToEntity(row, "SOURCE");
      const target = this.rowToEntity(row, "TARGET");
      const relation: Relation = {
        id: this.cell(row, "RELID") || `${source.id}_${this.cell(row, "RELLABEL")}_${target.id}`,
        label: this.cell(row, "RELLABEL"),
        sourceId: source.id,
        targetId: target.id,
        properties: safeJsonParse(this.cell(row, "RELPROPS")),
      };
      const key = `${source.id}|${relation.label}|${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ source, relation, target });
    }

    return results;
  }

  async getChunkTriplets(chunkIds: string[], options?: { depth?: number; limit?: number }): Promise<Array<{ triplet: Triplet; chunkIds: string[] }>> {
    if (chunkIds.length === 0) return [];

    const depth = Math.max(1, options?.depth ?? 1);
    const limit = options?.limit ?? 100;
    const chunkValues = chunkIds.map((id) => this.chunkUri(id)).join(" ");
    const path = `?chunk <${HKV}rel/DESCRIBES_ENTITY> ?seed .
      ${this.buildBoundedEntityExpansion("?seed", "?source", depth - 1)}`;

    const rows = await this.sparqlTable(`
      SELECT ?chunk ?sourceId ?sourceLabel ?sourceName ?sourceProps
             ?relId ?relLabel ?relProps
             ?targetId ?targetLabel ?targetName ?targetProps
      FROM <${this.graphName}>
      WHERE {
        VALUES ?chunk { ${chunkValues} }
        ${path}
        ?source ?predicate ?target .
        ?source <${RDF_TYPE}> <${HKV}type/ENTITY> .
        ?target <${RDF_TYPE}> <${HKV}type/ENTITY> .
        ?source <${HKV}prop/id> ?sourceId ; <${HKV}prop/label> ?sourceLabel ; <${HKV}prop/name> ?sourceName .
        ?target <${HKV}prop/id> ?targetId ; <${HKV}prop/label> ?targetLabel ; <${HKV}prop/name> ?targetName .
        OPTIONAL { ?source <${HKV}prop/propertiesJson> ?sourceProps . }
        OPTIONAL { ?target <${HKV}prop/propertiesJson> ?targetProps . }
        ?rel <${RDF_TYPE}> <${HKV}type/RELATION> .
        ?rel <${HKV}prop/sourceId> ?sourceId .
        ?rel <${HKV}prop/targetId> ?targetId .
        ?rel <${HKV}prop/id> ?relId .
        ?rel <${HKV}prop/label> ?relLabel .
        OPTIONAL { ?rel <${HKV}prop/propertiesJson> ?relProps . }
        FILTER(STRSTARTS(STR(?predicate), "${HKV}rel/"))
        FILTER(?predicate != <${HKV}rel/CONNECTED_TO>)
        FILTER(?predicate != <${HKV}rel/HAS_SOURCE_CHUNK>)
        FILTER(?predicate != <${HKV}rel/DESCRIBES_ENTITY>)
      }
      LIMIT ${limit}
    `);

    const byKey = new Map<string, { triplet: Triplet; chunkIds: string[] }>();
    for (const row of rows ?? []) {
      const source = this.rowToEntity(row, "SOURCE");
      const target = this.rowToEntity(row, "TARGET");
      const relation: Relation = {
        id: this.cell(row, "RELID") || `${source.id}_${this.cell(row, "RELLABEL")}_${target.id}`,
        label: this.cell(row, "RELLABEL"),
        sourceId: source.id,
        targetId: target.id,
        properties: safeJsonParse(this.cell(row, "RELPROPS")),
      };
      const key = `${source.id}|${relation.label}|${target.id}`;
      const chunkUri = this.cell(row, "CHUNK");
      const chunkId = this.extractChunkId(chunkUri);
      const existing = byKey.get(key);
      if (existing) {
        if (chunkId && !existing.chunkIds.includes(chunkId)) existing.chunkIds.push(chunkId);
      } else {
        byKey.set(key, { triplet: [source, relation, target], chunkIds: chunkId ? [chunkId] : [] });
      }
    }

    return Array.from(byKey.values());
  }

  async clear(): Promise<void> {
    await this.sparqlExecute(`CLEAR GRAPH <${this.graphName}>`).catch(() => {});
  }

  entityUri(entity: EntityNode): string {
    return `<${HKV}graph/${encodeURIComponent(this.graphName)}/entity/${encodeURIComponent(entity.id)}>`;
  }

  chunkUri(id: string): string {
    return `<${HKV}graph/${encodeURIComponent(this.graphName)}/chunk/${encodeURIComponent(id)}>`;
  }

  private relationUri(relation: Relation): string {
    const id = relation.id ?? `${relation.sourceId}_${relation.label}_${relation.targetId}`;
    return `<${HKV}graph/${encodeURIComponent(this.graphName)}/relation/${encodeURIComponent(id)}>`;
  }

  private predicateUri(label: string): string {
    return `<${HKV}rel/${encodeURIComponent(label)}>`;
  }

  private entityTriples(entity: EntityNode): string[] {
    const uri = this.entityUri(entity);
    return [
      `${uri} <${RDF_TYPE}> <${HKV}type/ENTITY> .`,
      `${uri} <${HKV}prop/id> "${escapeSparqlLiteral(entity.id)}" .`,
      `${uri} <${HKV}prop/label> "${escapeSparqlLiteral(entity.label)}" .`,
      `${uri} <${HKV}prop/name> "${escapeSparqlLiteral(entity.name)}" .`,
      `${uri} <${HKV}prop/propertiesJson> "${escapeSparqlLiteral(JSON.stringify(entity.properties ?? {}))}" .`,
    ];
  }

  private relationTriples(relation: Relation, source: EntityNode, target: EntityNode): string[] {
    const relationUri = this.relationUri(relation);
    const sourceUri = this.entityUri(source);
    const targetUri = this.entityUri(target);
    const predicateUri = this.predicateUri(relation.label);
    const id = relation.id ?? `${relation.sourceId}_${relation.label}_${relation.targetId}`;
    const properties = { ...(relation.properties ?? {}) };
    delete (properties as any).kg_nodes;
    delete (properties as any).kg_relations;

    return [
      `${sourceUri} ${predicateUri} ${targetUri} .`,
      `${sourceUri} <${HKV}rel/CONNECTED_TO> ${targetUri} .`,
      `${targetUri} <${HKV}rel/CONNECTED_TO> ${sourceUri} .`,
      `${relationUri} <${RDF_TYPE}> <${HKV}type/RELATION> .`,
      `${relationUri} <${HKV}prop/id> "${escapeSparqlLiteral(id)}" .`,
      `${relationUri} <${HKV}prop/label> "${escapeSparqlLiteral(relation.label)}" .`,
      `${relationUri} <${HKV}prop/sourceId> "${escapeSparqlLiteral(relation.sourceId)}" .`,
      `${relationUri} <${HKV}prop/targetId> "${escapeSparqlLiteral(relation.targetId)}" .`,
      `${relationUri} <${HKV}prop/propertiesJson> "${escapeSparqlLiteral(JSON.stringify(properties))}" .`,
    ];
  }

  private buildBoundedEntityExpansion(seedVar: string, outVar: string, depth: number): string {
    const boundedDepth = Math.max(0, Math.min(depth, 6));
    const branches = [`{ BIND(${seedVar} AS ${outVar}) }`];

    for (let hop = 1; hop <= boundedDepth; hop++) {
      const variables = Array.from({ length: hop }, (_unused, index) => `?hop${hop}_${index}`);
      const pathParts: string[] = [];
      let current = seedVar;

      for (let index = 0; index < variables.length; index++) {
        const next = variables[index];
        pathParts.push(`${current} <${HKV}rel/CONNECTED_TO> ${next} .`);
        current = next;
      }

      branches.push(`{ ${pathParts.join(" ")} BIND(${current} AS ${outVar}) }`);
    }

    return branches.join("\nUNION\n");
  }

  private async insertTriples(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const sparql = `INSERT DATA { GRAPH <${this.graphName}> { ${lines.join("\n")} } }`;
    await this.sparqlExecute(sparql);
  }

  private async sparqlTable(sparql: string): Promise<any[]> {
    const sql = `SELECT * FROM SPARQL_TABLE('${escapeSqlStringLiteral(sparql)}')`;
    return await this.exec(sql) as any[];
  }

  private async sparqlExecute(sparql: string, headers = ""): Promise<unknown> {
    try {
      const streamMod = await import("@sap/hana-client/extension/Stream");
      const Stream = (streamMod as any).default ?? streamMod;

      return await new Promise<unknown>((resolve, reject) => {
        Stream.createProcStatement(this.conn as any, "CALL SPARQL_EXECUTE(?, ?, ?, ?)", (err: any, stmt: any) => {
          if (err) return reject(err);
          stmt.exec([sparql, headers], (err2: any, scalarParams: any) => {
            if (err2) return reject(err2);
            resolve(scalarParams);
          });
        });
      });
    } catch {
      return await new Promise<unknown>((resolve, reject) => {
        (this.conn as any).exec("CALL SPARQL_EXECUTE(?, ?, ?, ?)", [sparql, headers], (err: unknown, result: unknown) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    }
  }

  private async exec(sql: string, params?: unknown[]): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      if (params && params.length > 0) {
        (this.conn as any).exec(sql, params, (err: unknown, result: unknown) => {
          if (err) reject(err);
          else resolve(result as unknown[]);
        });
      } else {
        this.conn.exec(sql, (err: unknown, result: unknown) => {
          if (err) reject(err);
          else resolve(result as unknown[]);
        });
      }
    });
  }

  private rowToEntity(row: any, prefix = ""): EntityNode {
    const p = prefix ? prefix.toUpperCase() : "";
    const id = this.cell(row, `${p}ID`) || this.cell(row, "ID");
    const label = this.cell(row, `${p}LABEL`) || this.cell(row, "LABEL");
    const name = this.cell(row, `${p}NAME`) || this.cell(row, "NAME");
    const props = this.cell(row, `${p}PROPS`) || this.cell(row, "PROPERTIES");
    return { id, label, name, properties: safeJsonParse(props) };
  }

  private cell(row: any, key: string): string {
    return String(row?.[key] ?? row?.[key.toLowerCase()] ?? "");
  }

  private extractChunkId(uri: string): string | undefined {
    const marker = "/chunk/";
    const idx = uri.indexOf(marker);
    if (idx < 0) return undefined;
    return decodeURIComponent(uri.slice(idx + marker.length).replace(/[<>]$/g, ""));
  }
}
