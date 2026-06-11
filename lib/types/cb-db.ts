export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      cb_annotation_codes: {
        Row: {
          annotation_id: string
          code_id: string
        }
        Insert: {
          annotation_id: string
          code_id: string
        }
        Update: {
          annotation_id?: string
          code_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cb_annotation_codes_annotation_id_fkey"
            columns: ["annotation_id"]
            isOneToOne: false
            referencedRelation: "cb_annotations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cb_annotation_codes_code_id_fkey"
            columns: ["code_id"]
            isOneToOne: false
            referencedRelation: "cb_codes"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_annotations: {
        Row: {
          anchor_status: string
          char_end: number
          char_start: number
          coder_id: string
          created_at: string
          id: string
          is_canonical: boolean
          kind: string
          prefix: string | null
          quote_text: string | null
          segment_id: string
          session_id: string
          suffix: string | null
          t_end_ms: number
          t_start_ms: number
          version_id: string
        }
        Insert: {
          anchor_status?: string
          char_end?: number
          char_start?: number
          coder_id: string
          created_at?: string
          id?: string
          is_canonical?: boolean
          kind: string
          prefix?: string | null
          quote_text?: string | null
          segment_id: string
          session_id: string
          suffix?: string | null
          t_end_ms: number
          t_start_ms: number
          version_id: string
        }
        Update: {
          anchor_status?: string
          char_end?: number
          char_start?: number
          coder_id?: string
          created_at?: string
          id?: string
          is_canonical?: boolean
          kind?: string
          prefix?: string | null
          quote_text?: string | null
          segment_id?: string
          session_id?: string
          suffix?: string | null
          t_end_ms?: number
          t_start_ms?: number
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cb_annotations_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "cb_segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cb_annotations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "cb_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cb_annotations_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "cb_transcript_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_citations: {
        Row: {
          authors: string | null
          bibtex_key: string | null
          bibtex_raw: string
          codebook_id: string
          created_at: string
          doi: string | null
          id: string
          parsed: Json | null
          title: string | null
          url: string | null
          year: number | null
        }
        Insert: {
          authors?: string | null
          bibtex_key?: string | null
          bibtex_raw: string
          codebook_id: string
          created_at?: string
          doi?: string | null
          id?: string
          parsed?: Json | null
          title?: string | null
          url?: string | null
          year?: number | null
        }
        Update: {
          authors?: string | null
          bibtex_key?: string | null
          bibtex_raw?: string
          codebook_id?: string
          created_at?: string
          doi?: string | null
          id?: string
          parsed?: Json | null
          title?: string | null
          url?: string | null
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "cb_citations_codebook_id_fkey"
            columns: ["codebook_id"]
            isOneToOne: false
            referencedRelation: "cb_codebooks"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_code_citations: {
        Row: {
          citation_id: string
          code_id: string
          role: string | null
        }
        Insert: {
          citation_id: string
          code_id: string
          role?: string | null
        }
        Update: {
          citation_id?: string
          code_id?: string
          role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cb_code_citations_citation_id_fkey"
            columns: ["citation_id"]
            isOneToOne: false
            referencedRelation: "cb_citations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cb_code_citations_code_id_fkey"
            columns: ["code_id"]
            isOneToOne: false
            referencedRelation: "cb_codes"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_code_facet_values: {
        Row: {
          code_id: string
          facet_value_id: string
        }
        Insert: {
          code_id: string
          facet_value_id: string
        }
        Update: {
          code_id?: string
          facet_value_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cb_code_facet_values_code_id_fkey"
            columns: ["code_id"]
            isOneToOne: false
            referencedRelation: "cb_codes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cb_code_facet_values_facet_value_id_fkey"
            columns: ["facet_value_id"]
            isOneToOne: false
            referencedRelation: "cb_facet_values"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_code_versions: {
        Row: {
          change_note: string | null
          code_id: string
          created_at: string
          created_by: string | null
          definition: string
          disconfirming_pattern: string | null
          exclude_if: Json
          exemplars: Json
          id: string
          include_if: Json
          prediction: string | null
          prediction_falsifier: string | null
          version: number
        }
        Insert: {
          change_note?: string | null
          code_id: string
          created_at?: string
          created_by?: string | null
          definition: string
          disconfirming_pattern?: string | null
          exclude_if?: Json
          exemplars?: Json
          id?: string
          include_if?: Json
          prediction?: string | null
          prediction_falsifier?: string | null
          version: number
        }
        Update: {
          change_note?: string | null
          code_id?: string
          created_at?: string
          created_by?: string | null
          definition?: string
          disconfirming_pattern?: string | null
          exclude_if?: Json
          exemplars?: Json
          id?: string
          include_if?: Json
          prediction?: string | null
          prediction_falsifier?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "cb_code_versions_code_id_fkey"
            columns: ["code_id"]
            isOneToOne: false
            referencedRelation: "cb_codes"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_codebook_versions: {
        Row: {
          calibration_round: number | null
          codebook_id: string
          frozen_at: string
          frozen_by: string | null
          id: string
          label: string
          note: string | null
          snapshot: Json
        }
        Insert: {
          calibration_round?: number | null
          codebook_id: string
          frozen_at?: string
          frozen_by?: string | null
          id?: string
          label: string
          note?: string | null
          snapshot: Json
        }
        Update: {
          calibration_round?: number | null
          codebook_id?: string
          frozen_at?: string
          frozen_by?: string | null
          id?: string
          label?: string
          note?: string | null
          snapshot?: Json
        }
        Relationships: [
          {
            foreignKeyName: "cb_codebook_versions_codebook_id_fkey"
            columns: ["codebook_id"]
            isOneToOne: false
            referencedRelation: "cb_codebooks"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_codebooks: {
        Row: {
          created_at: string
          description: string | null
          id: string
          method: string
          name: string
          study_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          method?: string
          name: string
          study_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          method?: string
          name?: string
          study_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cb_codebooks_study_id_fkey"
            columns: ["study_id"]
            isOneToOne: true
            referencedRelation: "studies"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_coder_comments: {
        Row: {
          author: string
          body: string
          code_id: string
          code_version: number | null
          created_at: string
          id: string
          resolved: boolean
        }
        Insert: {
          author: string
          body: string
          code_id: string
          code_version?: number | null
          created_at?: string
          id?: string
          resolved?: boolean
        }
        Update: {
          author?: string
          body?: string
          code_id?: string
          code_version?: number | null
          created_at?: string
          id?: string
          resolved?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "cb_coder_comments_code_id_fkey"
            columns: ["code_id"]
            isOneToOne: false
            referencedRelation: "cb_codes"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_codes: {
        Row: {
          codebook_id: string
          created_at: string
          current_version_id: string | null
          id: string
          mnemonic: string
          name: string
          origin: string
          parent_code_id: string | null
          retired_at: string | null
          status: string
        }
        Insert: {
          codebook_id: string
          created_at?: string
          current_version_id?: string | null
          id?: string
          mnemonic: string
          name: string
          origin: string
          parent_code_id?: string | null
          retired_at?: string | null
          status?: string
        }
        Update: {
          codebook_id?: string
          created_at?: string
          current_version_id?: string | null
          id?: string
          mnemonic?: string
          name?: string
          origin?: string
          parent_code_id?: string | null
          retired_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "cb_codes_codebook_id_fkey"
            columns: ["codebook_id"]
            isOneToOne: false
            referencedRelation: "cb_codebooks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cb_codes_current_version_fk"
            columns: ["current_version_id"]
            isOneToOne: false
            referencedRelation: "cb_code_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cb_codes_parent_code_id_fkey"
            columns: ["parent_code_id"]
            isOneToOne: false
            referencedRelation: "cb_codes"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_codings: {
        Row: {
          code_id: string
          code_version: number | null
          codebook_version_id: string | null
          coder: string | null
          created_at: string
          episode_ref: Json | null
          id: string
        }
        Insert: {
          code_id: string
          code_version?: number | null
          codebook_version_id?: string | null
          coder?: string | null
          created_at?: string
          episode_ref?: Json | null
          id?: string
        }
        Update: {
          code_id?: string
          code_version?: number | null
          codebook_version_id?: string | null
          coder?: string | null
          created_at?: string
          episode_ref?: Json | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cb_codings_code_id_code_version_fkey"
            columns: ["code_id", "code_version"]
            isOneToOne: false
            referencedRelation: "cb_code_versions"
            referencedColumns: ["code_id", "version"]
          },
          {
            foreignKeyName: "cb_codings_code_id_fkey"
            columns: ["code_id"]
            isOneToOne: false
            referencedRelation: "cb_codes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cb_codings_codebook_version_id_fkey"
            columns: ["codebook_version_id"]
            isOneToOne: false
            referencedRelation: "cb_codebook_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_facet_values: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          facet_id: string
          id: string
          key: string
          label: string
          position: number
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          facet_id: string
          id?: string
          key: string
          label: string
          position?: number
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          facet_id?: string
          id?: string
          key?: string
          label?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "cb_facet_values_facet_id_fkey"
            columns: ["facet_id"]
            isOneToOne: false
            referencedRelation: "cb_facets"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_facets: {
        Row: {
          cardinality: string
          codebook_id: string
          created_at: string
          description: string | null
          id: string
          key: string
          label: string
          position: number
        }
        Insert: {
          cardinality?: string
          codebook_id: string
          created_at?: string
          description?: string | null
          id?: string
          key: string
          label: string
          position?: number
        }
        Update: {
          cardinality?: string
          codebook_id?: string
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          label?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "cb_facets_codebook_id_fkey"
            columns: ["codebook_id"]
            isOneToOne: false
            referencedRelation: "cb_codebooks"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_memos: {
        Row: {
          author: string | null
          body: string
          codebook_id: string
          created_at: string
          id: string
          pid: string
          span: Json | null
        }
        Insert: {
          author?: string | null
          body: string
          codebook_id: string
          created_at?: string
          id?: string
          pid: string
          span?: Json | null
        }
        Update: {
          author?: string | null
          body?: string
          codebook_id?: string
          created_at?: string
          id?: string
          pid?: string
          span?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "cb_memos_codebook_id_fkey"
            columns: ["codebook_id"]
            isOneToOne: false
            referencedRelation: "cb_codebooks"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_profiles: {
        Row: {
          created_at: string
          display_name: string | null
          initials: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          initials?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          initials?: string | null
          user_id?: string
        }
        Relationships: []
      }
      cb_reliability_runs: {
        Row: {
          bias_index: number | null
          codebook_id: string
          codebook_version_id: string | null
          cohen_kappa: number | null
          computed_at: string
          degenerate: boolean
          dismissed_note: string | null
          id: string
          krippendorff_alpha: number | null
          n_coders: number | null
          n_units: number | null
          note: string | null
          pabak: number | null
          percent_agreement: number | null
          prevalence_index: number | null
          raw_labels: Json | null
          scope: string
          scope_code_id: string | null
          scope_facet_value_id: string | null
        }
        Insert: {
          bias_index?: number | null
          codebook_id: string
          codebook_version_id?: string | null
          cohen_kappa?: number | null
          computed_at?: string
          degenerate?: boolean
          dismissed_note?: string | null
          id?: string
          krippendorff_alpha?: number | null
          n_coders?: number | null
          n_units?: number | null
          note?: string | null
          pabak?: number | null
          percent_agreement?: number | null
          prevalence_index?: number | null
          raw_labels?: Json | null
          scope: string
          scope_code_id?: string | null
          scope_facet_value_id?: string | null
        }
        Update: {
          bias_index?: number | null
          codebook_id?: string
          codebook_version_id?: string | null
          cohen_kappa?: number | null
          computed_at?: string
          degenerate?: boolean
          dismissed_note?: string | null
          id?: string
          krippendorff_alpha?: number | null
          n_coders?: number | null
          n_units?: number | null
          note?: string | null
          pabak?: number | null
          percent_agreement?: number | null
          prevalence_index?: number | null
          raw_labels?: Json | null
          scope?: string
          scope_code_id?: string | null
          scope_facet_value_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cb_reliability_runs_codebook_id_fkey"
            columns: ["codebook_id"]
            isOneToOne: false
            referencedRelation: "cb_codebooks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cb_reliability_runs_codebook_version_id_fkey"
            columns: ["codebook_version_id"]
            isOneToOne: false
            referencedRelation: "cb_codebook_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cb_reliability_runs_scope_code_id_fkey"
            columns: ["scope_code_id"]
            isOneToOne: false
            referencedRelation: "cb_codes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cb_reliability_runs_scope_facet_value_id_fkey"
            columns: ["scope_facet_value_id"]
            isOneToOne: false
            referencedRelation: "cb_facet_values"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_segments: {
        Row: {
          created_at: string
          id: string
          ordinal: number
          session_id: string
          source: string
          speaker: string | null
          t_end_ms: number
          t_start_ms: number
          text: string
          track_index: number | null
          version_id: string
          words: Json | null
        }
        Insert: {
          created_at?: string
          id?: string
          ordinal: number
          session_id: string
          source?: string
          speaker?: string | null
          t_end_ms: number
          t_start_ms: number
          text: string
          track_index?: number | null
          version_id: string
          words?: Json | null
        }
        Update: {
          created_at?: string
          id?: string
          ordinal?: number
          session_id?: string
          source?: string
          speaker?: string | null
          t_end_ms?: number
          t_start_ms?: number
          text?: string
          track_index?: number | null
          version_id?: string
          words?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "cb_segments_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "cb_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cb_segments_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "cb_transcript_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      cb_sessions: {
        Row: {
          audio_path: string | null
          collection: string
          created_at: string
          created_by: string | null
          duration_ms: number | null
          id: string
          pid_label: string
          recording_started_at: string | null
          srt_path: string | null
          track_mode: string
          video_path: string | null
        }
        Insert: {
          audio_path?: string | null
          collection?: string
          created_at?: string
          created_by?: string | null
          duration_ms?: number | null
          id?: string
          pid_label: string
          recording_started_at?: string | null
          srt_path?: string | null
          track_mode?: string
          video_path?: string | null
        }
        Update: {
          audio_path?: string | null
          collection?: string
          created_at?: string
          created_by?: string | null
          duration_ms?: number | null
          id?: string
          pid_label?: string
          recording_started_at?: string | null
          srt_path?: string | null
          track_mode?: string
          video_path?: string | null
        }
        Relationships: []
      }
      cb_transcript_versions: {
        Row: {
          asr_engine: string | null
          created_at: string
          derived_from_version_id: string | null
          id: string
          is_verbatim: boolean
          kind: string
          session_id: string
        }
        Insert: {
          asr_engine?: string | null
          created_at?: string
          derived_from_version_id?: string | null
          id?: string
          is_verbatim?: boolean
          kind: string
          session_id: string
        }
        Update: {
          asr_engine?: string | null
          created_at?: string
          derived_from_version_id?: string | null
          id?: string
          is_verbatim?: boolean
          kind?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cb_transcript_versions_derived_from_version_id_fkey"
            columns: ["derived_from_version_id"]
            isOneToOne: false
            referencedRelation: "cb_transcript_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cb_transcript_versions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "cb_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_fields: {
        Row: {
          created_at: string
          field_key: string
          id: string
          label: string
          options: Json | null
          position: number
          required: boolean
          type: Database["public"]["Enums"]["onboarding_field_type"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          field_key: string
          id?: string
          label: string
          options?: Json | null
          position?: number
          required?: boolean
          type: Database["public"]["Enums"]["onboarding_field_type"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          field_key?: string
          id?: string
          label?: string
          options?: Json | null
          position?: number
          required?: boolean
          type?: Database["public"]["Enums"]["onboarding_field_type"]
          updated_at?: string
        }
        Relationships: []
      }
      onboarding_responses: {
        Row: {
          answered_at: string
          field_id: string
          id: string
          user_id: string
          value: Json
        }
        Insert: {
          answered_at?: string
          field_id: string
          id?: string
          user_id: string
          value: Json
        }
        Update: {
          answered_at?: string
          field_id?: string
          id?: string
          user_id?: string
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_responses_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "onboarding_fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_responses_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      studies: {
        Row: {
          authored_data: Json
          id: string
          name: string
          slug: string
          updated_at: string
          visibility: Database["public"]["Enums"]["project_visibility"]
        }
        Insert: {
          authored_data?: Json
          id?: string
          name: string
          slug: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["project_visibility"]
        }
        Update: {
          authored_data?: Json
          id?: string
          name?: string
          slug?: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["project_visibility"]
        }
        Relationships: []
      }
      study_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          module_id: string
          payload: Json
          study_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          module_id: string
          payload?: Json
          study_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          module_id?: string
          payload?: Json
          study_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_events_study_id_fkey"
            columns: ["study_id"]
            isOneToOne: false
            referencedRelation: "studies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      study_responses: {
        Row: {
          id: string
          section_key: string
          study_id: string
          updated_at: string
          user_id: string
          value: string
        }
        Insert: {
          id?: string
          section_key: string
          study_id: string
          updated_at?: string
          user_id: string
          value?: string
        }
        Update: {
          id?: string
          section_key?: string
          study_id?: string
          updated_at?: string
          user_id?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_responses_study_id_fkey"
            columns: ["study_id"]
            isOneToOne: false
            referencedRelation: "studies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_responses_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      study_scripts: {
        Row: {
          screen_key: string
          script_text: string
          study_id: string
          updated_at: string
        }
        Insert: {
          screen_key: string
          script_text?: string
          study_id: string
          updated_at?: string
        }
        Update: {
          screen_key?: string
          script_text?: string
          study_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_scripts_study_id_fkey"
            columns: ["study_id"]
            isOneToOne: false
            referencedRelation: "studies"
            referencedColumns: ["id"]
          },
        ]
      }
      study_snapshots: {
        Row: {
          client_ts: string | null
          created_at: string
          entities: Json
          id: string
          module_id: string
          phase: string
          scenario_idx: number | null
          spec: string
          study_id: string
          user_id: string
        }
        Insert: {
          client_ts?: string | null
          created_at?: string
          entities?: Json
          id?: string
          module_id: string
          phase: string
          scenario_idx?: number | null
          spec?: string
          study_id: string
          user_id: string
        }
        Update: {
          client_ts?: string | null
          created_at?: string
          entities?: Json
          id?: string
          module_id?: string
          phase?: string
          scenario_idx?: number | null
          spec?: string
          study_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_snapshots_study_id_fkey"
            columns: ["study_id"]
            isOneToOne: false
            referencedRelation: "studies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_snapshots_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          created_at: string
          email: string
          first_name: string
          has_onboarded: boolean
          id: string
          pid: string
        }
        Insert: {
          created_at?: string
          email: string
          first_name: string
          has_onboarded?: boolean
          id?: string
          pid: string
        }
        Update: {
          created_at?: string
          email?: string
          first_name?: string
          has_onboarded?: boolean
          id?: string
          pid?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      onboarding_field_type:
        | "short_text"
        | "long_text"
        | "select"
        | "multi_select"
        | "number"
      project_visibility: "shown" | "hidden" | "archived"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      onboarding_field_type: [
        "short_text",
        "long_text",
        "select",
        "multi_select",
        "number",
      ],
      project_visibility: ["shown", "hidden", "archived"],
    },
  },
} as const
