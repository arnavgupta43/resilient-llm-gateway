export interface Queryable {
  query(text: string, params: unknown[]): Promise<unknown>;
}
