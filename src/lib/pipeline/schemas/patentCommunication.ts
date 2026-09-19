/**
 * Built-in schema for communications issued by a patent office (office
 * actions, notifications, decisions). It is the deterministic alternative to
 * schema inference and a reasonable default for CNIPA correspondence.
 *
 * To add a schema for another kind of document, add a sibling file and
 * register it in `./index.ts`.
 */
import type { JsonSchemaObject } from "../../mistral/types";

const text = (description: string): JsonSchemaObject => ({ type: "string", description });

export const PATENT_COMMUNICATION_SCHEMA: JsonSchemaObject = {
  type: "object",
  description: "Structured translation of a communication from a patent office.",
  properties: {
    document_type: text("Kind of communication, e.g. 'First Office Action', 'Notification of Grant', 'Decision of Rejection'."),
    issuing_authority: text("Name of the patent office or department that issued the document."),
    document_title: text("Title of the document as printed."),
    application_number: text("Patent application number, verbatim."),
    publication_number: text("Publication or patent number if printed, else empty string."),
    invention_title: text("Title of the invention, translated."),
    applicant: text("Applicant(s) / patentee(s)."),
    agent: text("Patent agency and attorney of record, if printed."),
    examiner: text("Examiner name and/or examination department, if printed."),
    date_issued: text("Date the communication was issued (ISO 8601 when unambiguous)."),
    date_of_dispatch: text("Dispatch or notification date if different from date issued, else empty string."),
    response_deadline: text("Deadline or time limit to respond, including how it is computed (e.g. '4 months from the notification date')."),
    reference_numbers: {
      type: "array",
      description: "Any other identifiers printed on the document (file numbers, barcodes, form codes).",
      items: text("Identifier with a short label, e.g. 'Form code: 2019.1'."),
    },
    summary: text("Two to five sentence summary of what the office is communicating and what the applicant must do."),
    body_sections: {
      type: "array",
      description: "Main body of the communication in reading order, split into logical sections.",
      items: {
        type: "object",
        properties: {
          heading: text("Section heading, translated (or a short descriptive heading if the original has none)."),
          content: text("Full translated content of the section in Markdown. Preserve numbering, lists and tables."),
        },
        required: ["heading", "content"],
        additionalProperties: false,
      },
    },
    claim_objections: {
      type: "array",
      description: "Objections or findings per claim or claim group, if the document contains an examination analysis. Empty array otherwise.",
      items: {
        type: "object",
        properties: {
          claims: text("Claim numbers concerned, e.g. '1-3, 7'."),
          legal_basis: text("Legal provision relied on, e.g. 'Patent Law Art. 22(3) (inventive step)'."),
          reasoning: text("Examiner's reasoning, translated in full."),
        },
        required: ["claims", "legal_basis", "reasoning"],
        additionalProperties: false,
      },
    },
    cited_references: {
      type: "array",
      description: "Prior-art documents or other references cited. Empty array if none.",
      items: {
        type: "object",
        properties: {
          label: text("Label used in the document, e.g. 'D1' or 'Reference 1'."),
          identifier: text("Publication number or bibliographic identifier, verbatim."),
          notes: text("How the reference is used, translated. Empty string if not stated."),
        },
        required: ["label", "identifier", "notes"],
        additionalProperties: false,
      },
    },
    required_actions: {
      type: "array",
      description: "Concrete actions the applicant must or may take, each as one sentence.",
      items: text("One action."),
    },
    legal_provisions_cited: {
      type: "array",
      description: "Laws, articles, rules and guideline sections cited anywhere in the document.",
      items: text("One provision, e.g. 'Implementing Regulations Rule 53'."),
    },
    notes_for_reader: text("Translator notes: illegible passages, ambiguities, untranslated terms. Empty string if none."),
  },
  required: [
    "document_type",
    "issuing_authority",
    "document_title",
    "application_number",
    "publication_number",
    "invention_title",
    "applicant",
    "agent",
    "examiner",
    "date_issued",
    "date_of_dispatch",
    "response_deadline",
    "reference_numbers",
    "summary",
    "body_sections",
    "claim_objections",
    "cited_references",
    "required_actions",
    "legal_provisions_cited",
    "notes_for_reader",
  ],
  additionalProperties: false,
};
