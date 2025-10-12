import { Metadata } from 'main/types';
import Combatant from '../main/Combatant';
import { getLocalePhrase, Language } from '../localisation/translations';

import { VideoCategory } from '../types/VideoCategory';
import Activity from './Activity';
import { Phrase } from 'localisation/phrases';
import { DungeonTimelineSegment, TimelineSegmentType } from 'main/keystone';
import { Difficulty } from 'main/FFXIVTypes';

/**
 * Class representing a dungeon encounter.
 */
export default class FFXIVAllianceRaid extends Activity {
  private _difficulty: Difficulty;

  private _encounterName: string;

  private _Duration: number = 0;

  private _timeline: DungeonTimelineSegment[] = [];

  private _pull = 1;

  constructor(
    startDate: Date,
    encounterName: string,
    difficulty: Difficulty = Difficulty.Normal,
  ) {
    super(startDate, VideoCategory.FFXIVDungeons);
    this._difficulty = difficulty;
    this._encounterName = encounterName;
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
      throw new Error('[FFXIVDungeon] Tried to get result info but no result');
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

  get Duration() {
    return this._Duration;
  }

  set Duration(duration) {
    this._Duration = duration;
  }

  get timeline() {
    return this._timeline;
  }

  get currentSegment() {
    return this.timeline.at(-1);
  }

  getMetadata(): Metadata {
    const rawCombatants = Array.from(this.combatantMap.values()).map(
      (combatant: Combatant) => combatant.getRaw(),
    );

    const bossPercent = Math.round((100 * this.currentHp) / this.maxHp);

    return {
      category: VideoCategory.FFXIVDungeons,
      encounterName: this.encounterName,
      difficulty: Difficulty[this.difficulty],
      duration: this.duration,
      result: this.result,
      player: this.player.getRaw(),
      deaths: this.deaths,
      combatants: rawCombatants,
      start: this.startDate.getTime(),
      uniqueHash: this.getUniqueHash(),
      bossPercent,
      pull: this.pull,
    };
  }

  getFileName(): string {
    let fileName = `${this.encounterName} [${this.pull}] (${this.resultInfo})`;

    try {
      if (this.player.name !== undefined) {
        fileName = `${this.player.name} - ${fileName}`;
      }
    } catch {
      console.warn('[FFXIVDungeon] Failed to get player combatant');
    }

    return fileName;
  }

  endDungeon(endDate: Date, Duration: number, result: boolean) {
    this.endCurrentTimelineSegment(endDate);
    const lastSegment = this.currentSegment;

    if (lastSegment && lastSegment.length() < 10000) {
      console.debug(
        "[ChallengeModeDungeon] Removing last timeline segment because it's too short.",
      );
      this.removeLastTimelineSegment();
    }

    this.Duration = Duration;
    super.end(endDate, result);
  }

  addTimelineSegment(segment: DungeonTimelineSegment, endPrevious?: Date) {
    if (endPrevious) {
      this.endCurrentTimelineSegment(endPrevious);
    }

    this.timeline.push(segment);
  }

  endCurrentTimelineSegment(date: Date) {
    if (this.currentSegment) {
      this.currentSegment.logEnd = date;
    }
  }

  removeLastTimelineSegment() {
    this.timeline.pop();
  }

  getLastBossEncounter(): DungeonTimelineSegment | undefined {
    return this.timeline
      .slice()
      .reverse()
      .find((v) => v.segmentType === TimelineSegmentType.BossEncounter);
  }
}
