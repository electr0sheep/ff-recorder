import { Metadata } from 'main/types';
import Combatant from '../main/Combatant';
import { getLocalePhrase, Language } from '../localisation/translations';

import { VideoCategory } from '../types/VideoCategory';
import Activity from './Activity';
import { Phrase } from 'localisation/phrases';
import { Difficulty } from 'main/FFXIVTypes';

/**
 * Class representing a raid encounter.
 */
export default class FFXIVRaid extends Activity {
  private _difficulty: Difficulty;

  private _encounterName: string;

  private currentHp = 1;

  private maxHp = 1;

  private _pull = 1;

  constructor(
    startDate: Date,
    encounterName: string,
    difficulty: Difficulty = Difficulty.Normal,
  ) {
    super(startDate, VideoCategory.FFXIVRaids);
    this._difficulty = difficulty;
    this._encounterName = encounterName;
    this.overrun = 3; // Even for wipes it's nice to have some overrun.
  }

  get pull() {
    return this._pull;
  }

  set pull(pullNumber: number) {
    this._pull = pullNumber;
  }

  get encounterName() {
    return this._encounterName;
  }

  get resultInfo() {
    if (this.result === undefined) {
      throw new Error('[FFXIVRaid] Tried to get result info but no result');
    }

    const language = this.cfg.get<string>('language') as Language;

    if (this.result) {
      return getLocalePhrase(language, Phrase.Kill);
    }

    return getLocalePhrase(language, Phrase.Wipe);
  }

  get difficulty() {
    return this._difficulty;
  }

  getMetadata(): Metadata {
    const rawCombatants = Array.from(this.combatantMap.values()).map(
      (combatant: Combatant) => combatant.getRaw(),
    );

    const bossPercent = Math.round((100 * this.currentHp) / this.maxHp);

    return {
      category: VideoCategory.FFXIVRaids,
      encounterName: this.encounterName,
      difficulty: Difficulty[this.difficulty],
      duration: this.duration,
      result: this.result,
      player: this.player.getRaw(),
      deaths: this.deaths,
      overrun: this.overrun,
      combatants: rawCombatants,
      start: this.startDate.getTime(),
      uniqueHash: this.getUniqueHash(),
      bossPercent,
      pull: this.pull,
    };
  }

  getFileName(): string {
    let fileName = `${this.encounterName} (${Difficulty[this.difficulty]}) [${this.pull}] (${this.resultInfo})`;

    try {
      if (this.player.name !== undefined) {
        fileName = `${this.player.name} - ${fileName}`;
      }
    } catch {
      console.warn('[FFXIVRaid] Failed to get player combatant');
    }

    return fileName;
  }

  /**
   * Update the max and current HP of the boss. Used to calculate the
   * HP percentage at the end of the fight.
   *
   * The log handler doesn't have a way to tell if the unit is the boss or
   * not (atleast, not without hardcoding boss names), so we let the handler
   * call this this on any unit, but ignore any units with less than the max HP
   * of the boss.
   *
   * It's a fairly safe bet that the boss will always have the most HP in an
   * encounter. Can't think of any fights where this isn't true.
   */
  public updateHp(current: number, max: number): void {
    if (max < this.maxHp) return;
    this.maxHp = max;
    this.currentHp = current;
  }
}
