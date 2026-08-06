/**
 * The PREREGISTERED reliability target: mean per-code strict κ ≥ 0.70 on the
 * pooled sentence units of the measurement sessions.
 *
 * Provenance (see docs/irr-design.md and the 08-04 precedent reading guide):
 *  - Aug 4 meeting (Zihan / David / Moonwara): "aiming for a 0.7" on the
 *    sessions coded independently after the two calibration sessions.
 *  - McDonald et al. 2019 §5.3.5: state a target agreement value (e.g. 0.7 or
 *    above) WITH justification BEFORE the analysis — a post-hoc threshold is
 *    not a preregistration.
 *  - Decision rule (David's constraint — choosing IRR obligates acting on it):
 *    reached → the codebook is reliable; solo-code the remainder
 *    (Kazemitabaar et al. 2023 precedent). Not reached → revise the codebook
 *    and run another independent round; do NOT lower the target.
 *
 * Lives outside app/actions because 'use server' modules may only export async
 * functions; both the server action and the client UI import it from here.
 */
export const IRR_TARGET_KAPPA = 0.7;
