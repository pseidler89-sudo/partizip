/**
 * types.ts — Digest-Generator-Typen (M7)
 *
 * Interface DigestGenerator: deterministisch, kein LLM in M7.
 * Alle Aussagen MÜSSEN eine source_document_id + sourceUrl haben.
 */

export interface DraftStatement {
  position: number;
  text: string;
  /** FK auf ris_documents.id */
  sourceDocumentId: string;
  sourceUrl: string;
}

export interface DraftDigest {
  title: string;
  generator: string;
  statements: DraftStatement[];
}

export interface DocumentInput {
  id: string;
  docType: string;
  title: string | null;
  bodyText: string | null;
  sourceUrl: string;
  externalId: string | null;
}

export interface MeetingInput {
  id: string;
  gremium: string | null;
  title: string | null;
  meetingDate: Date | null;
  location: string | null;
  // M1(c): Stabile Meeting-URL — verwendet als Fallback-sourceUrl für Wicket-PDF-Statements
  sourceUrl?: string;
}

export interface DigestGenerator {
  generate(meeting: MeetingInput, documents: DocumentInput[]): Promise<DraftDigest>;
}
