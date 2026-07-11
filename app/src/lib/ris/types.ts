/**
 * types.ts — Gemeinsame Typen für RIS-Adapter (M7)
 *
 * Beide Adapter (Provox IIP, ALLRIS 4) implementieren das RisAdapter-Interface.
 * Tests injizieren Fetch-Stubs — kein Live-HTTP in Tests.
 */

// ---------------------------------------------------------------------------
// Shared Types
// ---------------------------------------------------------------------------

export interface MeetingRef {
  externalId: string;
  gremium?: string;
  title?: string;
  meetingDate?: Date;
  location?: string;
  sourceUrl: string;
}

export interface DocumentRef {
  docType: "einladung" | "tagesordnung" | "protokoll" | "vorlage" | "anlage" | "top";
  externalId?: string;
  title?: string;
  bodyText?: string | null;
  // M1(c): Primäre URL (Download/Ressource) — kann instabile Wicket-URL sein
  sourceUrl: string;
  // M1(c): Stabile öffentliche Seite für Digest-Statements (ALLRIS: to010/to020/vo020;
  // Provox: meeting/details oder getfile). NIE in digest_statements persistieren wenn fehlt.
  stableSourceUrl?: string;
  contentHash?: string;
}

export interface FetchedMeeting {
  meeting: MeetingRef;
  documents: DocumentRef[];
}

// ---------------------------------------------------------------------------
// Adapter Interface
// ---------------------------------------------------------------------------

export interface RisAdapter {
  /**
   * Liefert aktuelle/kommende und letzte Sitzungen.
   * Bei ALLRIS (keine API): liest bekannte SILFDNRs aus der DB.
   */
  listRecentMeetings(): Promise<MeetingRef[]>;

  /**
   * Lädt Details + Dokumente einer Sitzung.
   */
  fetchMeeting(ref: MeetingRef): Promise<FetchedMeeting>;
}

// ---------------------------------------------------------------------------
// Fetch-Wrapper-Typen (für Injection in Tests)
// ---------------------------------------------------------------------------

export type FetchFn = (url: string) => Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; ok: boolean; status: number }>;
