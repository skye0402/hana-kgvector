export type SpaceCreateInput = {
  id: string;
  name: string;
  description?: string;
};

export type Space = {
  id: string;
  name: string;
  description?: string;
  rdfGraphName: string;
  vectorTableName: string;
  createdAt: Date;
};
