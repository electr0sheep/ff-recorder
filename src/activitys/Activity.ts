import crypto from 'crypto';
import ConfigService from 'config/ConfigService';
import { PlayerDeathType, Flavour, Metadata } from '../main/types';
import Combatant from '../main/Combatant';
import { VideoCategory } from '../types/VideoCategory';

/**
 * Abstract activity class.
 */
export default abstract class Activity {
  protected _category: VideoCategory;

  protected _result: boolean;

  protected _combatantMap: Map<string, Combatant>;

  protected _startDate: Date;

  protected _deaths: PlayerDeathType[];

  protected _flavour: Flavour | undefined;

  protected _endDate?: Date;

  protected _zoneID?: number;

  protected _playerGUID?: string;

  protected _overrun: number = 0;

  /** Seconds the recording was cut back before the start date. */
  protected _cutback: number = 0;

  /** Spans of the recording to cut out of the video, see addIntermission. */
  protected _intermissions: { start: Date; end: Date }[] = [];

  protected cfg = ConfigService.getInstance();

  constructor(startDate: Date, category: VideoCategory, flavour?: Flavour) {
    this._result = false;
    this._combatantMap = new Map();
    this._startDate = startDate;
    this._category = category;
    this._deaths = [];
    this._flavour = flavour;
  }

  abstract getMetadata(): Metadata;
  abstract getFileName(): string;

  get zoneID() {
    return this._zoneID;
  }

  set zoneID(zoneID) {
    this._zoneID = zoneID;
  }

  get category() {
    return this._category;
  }

  set category(category) {
    this._category = category;
  }

  get startDate() {
    return this._startDate;
  }

  set startDate(date) {
    this._startDate = date;
  }

  get result() {
    return this._result;
  }

  set result(result) {
    this._result = result;
  }

  get deaths() {
    return this._deaths;
  }

  get playerGUID() {
    return this._playerGUID;
  }

  set playerGUID(guid) {
    this._playerGUID = guid;
  }

  get endDate() {
    return this._endDate;
  }

  set endDate(date) {
    this._endDate = date;
  }

  get combatantMap() {
    return this._combatantMap;
  }

  set combatantMap(cm) {
    this._combatantMap = cm;
  }

  get flavour() {
    return this._flavour;
  }

  set flavour(flavour) {
    this._flavour = flavour;
  }

  get overrun() {
    return this._overrun;
  }

  set overrun(s) {
    console.info('[Activity] Setting overrun to', s);
    this._overrun = s;
  }

  get cutback() {
    return this._cutback;
  }

  set cutback(s) {
    this._cutback = s;
  }

  get intermissions() {
    return this._intermissions;
  }

  /**
   * Length of the video in seconds: the activity plus the overrun, less any
   * intermissions, which are cut out of the video.
   */
  get duration() {
    if (!this.endDate) {
      throw new Error('Failed to get duration of in-progress activity');
    }

    const baseDuration =
      (this.endDate.getTime() - this.startDate.getTime()) / 1000;

    return baseDuration + this.overrun - this.intermissionDuration;
  }

  /**
   * Seconds of the recording taken up by intermissions.
   */
  get intermissionDuration() {
    return this.intermissions.reduce(
      (total, { start, end }) =>
        total + (end.getTime() - start.getTime()) / 1000,
      0,
    );
  }

  get player() {
    if (!this.playerGUID) {
      throw new Error('Failed to get player combatant, playerGUID not set');
    }

    const player = this.getCombatant(this.playerGUID);

    if (!player) {
      throw new Error('Player not found in combatants');
    }

    return player;
  }

  end(endDate: Date, result: boolean) {
    endDate.setTime(endDate.getTime());
    this.endDate = endDate;
    this.result = result;
  }

  getCombatant(GUID: string) {
    return this.combatantMap.get(GUID);
  }

  addCombatant(combatant: Combatant) {
    this.combatantMap.set(combatant.GUID, combatant);
  }

  addDeath(death: PlayerDeathType) {
    this.deaths.push(death);
  }

  /**
   * Mark a span of the activity to cut out of the video, e.g. a mid-fight
   * cutscene. Spans must not overlap.
   */
  addIntermission(start: Date, end: Date) {
    if (end.getTime() <= start.getTime()) {
      return;
    }

    this.intermissions.push({ start, end });
  }

  /**
   * Convert seconds from the start of the activity into seconds into the
   * video, i.e. with the intermissions taken out. A time inside an
   * intermission lands where the intermission was cut.
   */
  toVideoTime(seconds: number) {
    let removed = 0;

    this.intermissions.forEach(({ start, end }) => {
      const from = (start.getTime() - this.startDate.getTime()) / 1000;
      const to = (end.getTime() - this.startDate.getTime()) / 1000;

      if (seconds >= to) {
        removed += to - from;
      } else if (seconds > from) {
        removed += seconds - from;
      }
    });

    return seconds - removed;
  }

  /**
   * Gets fields from the metadata that are deterministic and hashes them. This is used to
   * correlate videos; deliberately excludes fields that vary from player to player for this
   * reason. Does not include start time as I'm not sure it's totally fixed across multi povs;
   * it might vary slightly with local system clock.
   */
  getUniqueHash(pull: number = 0, ...fields: string[]): string {
    let deterministicFields = [];

    if (this.flavour) {
      deterministicFields = [this.category, this.flavour, this.result].map(
        (f) => f.toString(),
      );
    } else {
      // FFXIV activities have no flavour. The pull number distinguishes
      // retries of the same fight, and the activity passes whatever else
      // tells fights apart (the map and boss, as pulls are numbered per
      // boss); combatant names are appended below.
      deterministicFields = [this.category, this.result, pull, ...fields].map(
        (f) => f.toString(),
      );
    }

    const sortedNames: string[] = [];

    Array.from(this.combatantMap.values())
      .map((combatant) => combatant.name)
      .sort()
      .forEach((name) => {
        if (name) sortedNames.push(name);
      });

    const uniqueString = deterministicFields.join(' ') + sortedNames.join(' ');

    // Hash instances are one-shot after digest(), so keep this call stateless.
    return crypto.createHash('md5').update(uniqueString).digest('hex');
  }
}
