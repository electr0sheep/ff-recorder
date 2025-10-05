import VideoProcessQueue from '../main/VideoProcessQueue';
import Combatant from '../main/Combatant';
import ConfigService from '../config/ConfigService';
import { instanceDifficulty } from '../main/constants';
import Recorder from '../main/Recorder';
import {
  Flavour,
  PlayerDeathType,
  SoundAlerts,
  VideoQueueItem,
} from '../main/types';
import Activity from '../activitys/Activity';
import RaidEncounter from '../activitys/RaidEncounter';

import {
  ambiguate,
  isUnitFriendly,
  isUnitPlayer,
  isUnitSelf,
} from './logutils';

import { VideoCategory } from '../types/VideoCategory';
import { allowRecordCategory } from '../utils/configUtils';
import { assert } from 'console';
import Manual from 'activitys/Manual';
import { playSoundAlert } from 'main/main';
import Poller from 'utils/Poller';
import { emitErrorReport } from 'main/util';
import FFXIVCombatLogWatcher from './FFXIVCombatLogWatcher';
import FFXIVLogLine from './FFXIVLogLine';

/**
 * Generic LogHandler class. Everything in this class must be valid for both
 * classic and retail combat logs.
 *
 * If you need something flavour specific then put it in the appropriate
 * subclass; i.e. RetailLogHandler, ClassicLogHandler or EraLogHandler.
 *
 * Static fields in this class provide locking function. While we will
 * typically have up to 4 child classes, we don't want multiple concurrent
 * activities.
 */
export default abstract class FFXIVGenericLogHandler {
  public static activity: Activity | undefined;

  public static overrunning = false;

  private static minBossHp = 100 * 10 ** 6;

  public combatLogWatcher: FFXIVCombatLogWatcher;

  protected player: Combatant | undefined;

  private static stateChangeCallback: () => void;

  constructor(logPath: string, dataTimeout: number) {
    console.debug('[FFXIVGenericLogHandler] Starting');
    this.combatLogWatcher = new FFXIVCombatLogWatcher(logPath, dataTimeout);
    this.combatLogWatcher.watch();

    this.combatLogWatcher.on('timeout', (ms: number) => {
      this.dataTimeout(ms);
    });

    // For ease of testing force stop.
    this.combatLogWatcher.on('WARCRAFT_RECORDER_FORCE_STOP', () => {
      FFXIVGenericLogHandler.forceEndActivity();
    });
  }

  public static setStateChangeCallback = (
    cb: typeof FFXIVGenericLogHandler.stateChangeCallback,
  ) => {
    this.stateChangeCallback = cb;
  };

  public destroy() {
    this.combatLogWatcher.unwatch();
    this.combatLogWatcher.removeAllListeners();
  }

  protected static async startActivity(activity: Activity) {
    const { category } = activity;
    const allowed = allowRecordCategory(ConfigService.getInstance(), category);

    if (!allowed) {
      console.info(
        '[FFXIVGenericLogHandler] Not configured to record',
        category,
      );
      return;
    }

    console.info(
      `[FFXIVGenericLogHandler] Start recording a video for category: ${category}`,
    );

    // Offset is the number of seconds to cut back into the buffer. That way
    // the buffer length is irrelevant. It is physically impossible to have
    // a negative offset. That would mean an activity started in the future.
    const offset = (Date.now() - activity.startDate.getTime()) / 1000;
    console.info(`[FFXIVGenericLogHandler] Calculated offset seconds`, offset);
    assert(offset >= 0);

    try {
      FFXIVGenericLogHandler.activity = activity;
      await Recorder.getInstance().startRecording(offset);
      FFXIVGenericLogHandler.stateChangeCallback();
    } catch (error) {
      console.error(
        '[FFXIVGenericLogHandler] Error starting activity',
        String(error),
      );
      FFXIVGenericLogHandler.activity = undefined;
    }
  }

  /**
   * End the recording after the overrun has elasped. Every single activity
   * ending comes through this function.
   */
  protected static async endActivity() {
    if (!FFXIVGenericLogHandler.activity) {
      console.error(
        "[FFXIVGenericLogHandler] No active activity so can't stop",
      );
      return;
    }

    console.info(
      `[FFXIVGenericLogHandler] Ending recording video for category: ${FFXIVGenericLogHandler.activity.category}`,
    );

    // It's important we clear the activity before we call stop as stop will
    // await for the overrun, and we might do weird things if the player
    // immediately starts a new activity while we're awaiting. See issue 291.
    const lastActivity = FFXIVGenericLogHandler.activity;
    FFXIVGenericLogHandler.overrunning = true;
    FFXIVGenericLogHandler.activity = undefined;

    const { overrun } = lastActivity;

    if (overrun > 0) {
      console.info('[FFXIVGenericLogHandler] Awaiting overrun:', overrun);
      FFXIVGenericLogHandler.stateChangeCallback();
      await new Promise((resolve) => setTimeout(resolve, 1000 * overrun));
      console.info('[FFXIVGenericLogHandler] Done awaiting overrun');
    }

    FFXIVGenericLogHandler.overrunning = false;
    const recorder = Recorder.getInstance();
    const poller = Poller.getInstance();

    let videoFile;

    const stopPromise = recorder.stop(); // Queue the stop.
    const wowRunning = poller.isWowRunning();

    if (wowRunning) {
      // Immediately queue the buffer start so it's ready if we go instantly into another activity.
      console.info(
        '[FFXIVGenericLogHandler] Queue buffer start as WoW still running',
      );
      recorder.startBuffer(); // No assignment, we don't care about when it's done.
    }

    try {
      // Now await the stop so we get the file from the recorder. Clear it
      // when we do to prevent it being reused.
      await stopPromise;
      videoFile = recorder.getAndClearLastFile();
    } catch (error) {
      console.error(
        '[FFXIVGenericLogHandler] Failed to stop recording, discarding video',
        error,
      );

      const report =
        'Failed to stop recording, discarding: ' + lastActivity.getFileName();
      emitErrorReport(report);

      return;
    }

    if (!videoFile) {
      console.error('[FFXIVGenericLogHandler] No video file available');

      const report =
        'No video file produced, discarding: ' + lastActivity.getFileName();
      emitErrorReport(report);

      return;
    }

    try {
      const metadata = lastActivity.getMetadata();
      const { duration } = metadata;
      const suffix = lastActivity.getFileName();

      if (lastActivity.category === VideoCategory.Raids) {
        const minDuration = ConfigService.getInstance().get<number>(
          'minEncounterDuration',
        );
        const notLongEnough = duration < minDuration;

        if (notLongEnough) {
          console.info(
            '[FFXIVGenericLogHandler] Discarding raid encounter, too short',
          );
          return;
        }
      }

      const queueItem: VideoQueueItem = {
        source: videoFile,
        suffix,
        offset: 0, // We don't need to offset here, we've already cut the buffer back.
        duration,
        metadata,
        clip: false,
      };

      VideoProcessQueue.getInstance().queueVideo(queueItem);
    } catch (error) {
      // We've failed to get the Metadata from the activity. Throw away the
      // video and log why. Example of when we hit this is on raid resets
      // where we don't have long enough to get a GUID for the player.
      console.warn(
        '[FFXIVGenericLogHandler] Discarding video as failed to get Metadata:',
        String(error),
      );
    }
  }

  protected async dataTimeout(ms: number) {
    console.info(
      `[FFXIVGenericLogHandler] Haven't received data for combatlog in ${
        ms / 1000
      } seconds.`,
    );

    if (FFXIVGenericLogHandler.activity) {
      await FFXIVGenericLogHandler.forceEndActivity(-ms / 1000);
    }
  }

  public static async forceEndActivity(timedelta = 0) {
    if (!FFXIVGenericLogHandler.activity) {
      console.error(
        '[FFXIVGenericLogHandler] forceEndActivity called but no activity',
      );
      return;
    }

    console.info(
      '[FFXIVGenericLogHandler] Force ending activity, timedelta:',
      timedelta,
    );
    const endDate = new Date();
    endDate.setTime(endDate.getTime() + timedelta * 1000);
    FFXIVGenericLogHandler.activity.overrun = 0;

    FFXIVGenericLogHandler.activity.end(endDate, false);
    await FFXIVGenericLogHandler.endActivity();
    FFXIVGenericLogHandler.activity = undefined;
  }

  public static dropActivity() {
    FFXIVGenericLogHandler.overrunning = false;
    FFXIVGenericLogHandler.activity = undefined;
  }

  protected async zoneChangeStop(line: FFXIVLogLine) {
    if (!FFXIVGenericLogHandler.activity) {
      console.error(
        '[FFXIVGenericLogHandler] No active activity on zone change stop',
      );

      return;
    }

    const endDate = line.date();
    FFXIVGenericLogHandler.activity.end(endDate, false);
    await FFXIVGenericLogHandler.endActivity();
  }

  protected isArena() {
    if (!FFXIVGenericLogHandler.activity) {
      return false;
    }

    const { category } = FFXIVGenericLogHandler.activity;

    return (
      category === VideoCategory.TwoVTwo ||
      category === VideoCategory.ThreeVThree ||
      category === VideoCategory.FiveVFive ||
      category === VideoCategory.Skirmish ||
      category === VideoCategory.SoloShuffle
    );
  }

  protected isBattleground() {
    if (!FFXIVGenericLogHandler.activity) {
      return false;
    }

    const { category } = FFXIVGenericLogHandler.activity;
    return category === VideoCategory.Battlegrounds;
  }

  protected isMythicPlus() {
    if (!FFXIVGenericLogHandler.activity) {
      return false;
    }

    const { category } = FFXIVGenericLogHandler.activity;
    return category === VideoCategory.MythicPlus;
  }

  protected processCombatant(
    srcGUID: string,
    srcNameRealm: string,
    srcFlags: number,
    allowNew: boolean,
  ) {
    let combatant: Combatant | undefined;

    if (!FFXIVGenericLogHandler.activity) {
      return combatant;
    }

    // Logs sometimes emit this GUID and we don't want to include it.
    // No idea what causes it. Seems really common but not exlusive on
    // "Shadow Word: Death" casts.
    if (srcGUID === '0000000000000000') {
      return combatant;
    }

    if (!isUnitPlayer(srcFlags)) {
      return combatant;
    }

    // We check if we already know the playerGUID here, no point updating it
    // because it can't change, unless the user changes characters mid
    // recording like in issue 355, in which case better to retain the initial
    // character details.
    if (!FFXIVGenericLogHandler.activity.playerGUID && isUnitSelf(srcFlags)) {
      FFXIVGenericLogHandler.activity.playerGUID = srcGUID;
    }

    // Even if the combatant exists already we still update it with the info it
    // may not have yet. We can't tell the name, realm or if it's the player
    // from COMBATANT_INFO events.
    combatant = FFXIVGenericLogHandler.activity.getCombatant(srcGUID);

    if (allowNew && combatant === undefined) {
      // We've failed to get a pre-existing combatant, but we are allowed to add it.
      combatant = new Combatant(srcGUID);
    } else if (combatant === undefined) {
      // We've failed to get a pre-existing combatant, and we're not allowed to add it.
      return combatant;
    }

    if (combatant.isFullyDefined()) {
      // No point doing anything more here, we already know all the details.
      return combatant;
    }

    [combatant.name, combatant.realm, combatant.region] =
      ambiguate(srcNameRealm);
    FFXIVGenericLogHandler.activity.addCombatant(combatant);
    return combatant;
  }

  protected handleSpellDamage(line: FFXIVLogLine) {
    if (
      !FFXIVGenericLogHandler.activity ||
      FFXIVGenericLogHandler.activity.category !== VideoCategory.Raids
    ) {
      // We only care about this event for working out boss HP, which we
      // only do in raids.
      return;
    }

    const max = parseInt(line.arg(15), 10);

    if (
      FFXIVGenericLogHandler.activity.flavour === Flavour.Retail &&
      max < FFXIVGenericLogHandler.minBossHp
    ) {
      // Assume that if the HP is less than 100 million then it's not a boss.
      // That avoids us marking bosses as 0% when they haven't been touched
      // yet, i.e. short pulls on Gallywix before the shield is broken and we are
      // yet to see SPELL_DAMAGE events (and instead get SPELL_ABSORBED). Only do
      // this for retail as classic will have lower HP bosses and I can't be
      // bothered worrying about it there.
      return;
    }

    const raid = FFXIVGenericLogHandler.activity as RaidEncounter;
    const current = parseInt(line.arg(14), 10);

    // We don't check the unit here, the RaidEncounter class has logic
    // to discard an update that lowers the max HP. That's a strategy to
    // avoid having to maintain a list of boss unit names. It's a reasonable
    // assumption usually that the boss has the most HP of all the units.
    raid.updateHp(current, max);
  }

  /**
   * Handle the pressing of the manual recording hotkey.
   */
  public static async handleManualRecordingHotKey() {
    const sounds = ConfigService.getInstance().get('manualRecordSoundAlert');

    if (!FFXIVGenericLogHandler.activity) {
      console.info('[FFXIVGenericLogHandler] Starting manual recording');
      const startDate = new Date();
      const activity = new Manual(startDate, Flavour.Retail);
      await FFXIVGenericLogHandler.startActivity(activity);
      if (sounds) playSoundAlert(SoundAlerts.MANUAL_RECORDING_START);
      return;
    }

    if (FFXIVGenericLogHandler.activity.category === VideoCategory.Manual) {
      console.info('[FFXIVGenericLogHandler] Stopping manual recording');
      const endDate = new Date();
      FFXIVGenericLogHandler.activity.end(endDate, true); // Result is meaningless but required.
      await FFXIVGenericLogHandler.endActivity();
      if (sounds) playSoundAlert(SoundAlerts.MANUAL_RECORDING_STOP);
      return;
    }

    console.warn('[FFXIVGenericLogHandler] Unable to start manual recording');
    if (sounds) playSoundAlert(SoundAlerts.MANUAL_RECORDING_ERROR);
  }
}
