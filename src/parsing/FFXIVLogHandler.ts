import FFXIVGenericLogHandler from './FFXIVGenericLogHandler';
import FFXIVLogLine from './FFXIVLogLine';
import { VideoCategory } from 'types/VideoCategory';
import Combatant from 'main/Combatant';
import {
  ars,
  chaoticArs,
  criterionDungeons,
  dungeons,
  raids,
  trials,
  ultimateRaids,
  variantDungeons,
} from 'main/FFXIVConstants';
import ConfigService from 'config/ConfigService';
import FFXIVTrial from 'activitys/FFXIVTrial';
import Activity from 'activitys/Activity';
import { LogType, Job } from 'main/FFXIVTypes';

/**
 * FFXIVLogHandler class.
 */
export default class FFXIVLogHandler extends FFXIVGenericLogHandler {
  constructor(logPath: string) {
    super(logPath, 10);

    this.combatLogWatcher.on(
      LogType.ZONE_CHANGE,
      async (line: FFXIVLogLine) => {
        await this.handleZoneChange(line);
      },
    );
    this.combatLogWatcher.on(LogType.COMBATANT, async (line: FFXIVLogLine) => {
      await this.handleCombatant(line);
    });
    this.combatLogWatcher.on(LogType.PLAYER, async (line: FFXIVLogLine) => {
      await this.handlePlayer(line);
    });
  }

  private async handleZoneChange(line: FFXIVLogLine) {
    const [
      territoryId,
      contentFinderCondition,
      inContentFinderContent,
      unrestrictedParty,
      minimalItemLevel,
      silenceEcho,
      exploreMode,
      levelSync,
    ] = this.parseLogLine(line);
    const [zone, difficulty] = this.parseZone(line.arg(3));
    console.debug('[FFXIVLogHandler] Zone: ', zone);
    console.debug(
      territoryId,
      contentFinderCondition,
      inContentFinderContent,
      unrestrictedParty,
      minimalItemLevel,
      silenceEcho,
      exploreMode,
      levelSync,
    );
    if (
      trials.includes(zone) &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordTrials')
    ) {
      const activity = new FFXIVTrial(line.date(), zone, difficulty);
      // const combatant = new Combatant('12345');
      // combatant.name = 'Kementari Yavanna';
      // activity.addCombatant(combatant);
      // activity.playerGUID = '12345';
      this.startRecording(activity);
    } else if (
      raids.includes(zone) &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordRaids')
    ) {
      this.startRecording(line, VideoCategory.FFXIVRaids);
    } else if (
      dungeons.includes(zone) &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordDungeons')
    ) {
      this.startRecording(line, VideoCategory.FFXIVDungeons);
    } else if (
      ars.includes(zone) &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordAllianceRaids')
    ) {
      this.startRecording(line, VideoCategory.FFXIVAllianceRaids);
    } else if (ultimateRaids.includes(zone)) {
      this.startRecording(line, VideoCategory.FFXIVAllianceRaids);
    } else if (chaoticArs.includes(zone)) {
      this.startRecording(line, VideoCategory.FFXIVAllianceRaids);
    } else if (variantDungeons.includes(zone)) {
      this.startRecording(line, VideoCategory.FFXIVAllianceRaids);
    } else if (criterionDungeons.includes(zone)) {
      this.startRecording(line, VideoCategory.FFXIVAllianceRaids);
    } else {
      this.endRecording(line);
    }
  }

  private async handleCombatant(line: FFXIVLogLine) {
    if (FFXIVGenericLogHandler.activity) {
      const guid = line.arg(2);
      const name = line.arg(3);
      const job = line.arg(4) as Job;
      if (job !== Job.None) {
        console.debug('[FFXIVLogHandler] handleCombatant: ', guid, name, job);
        // const job: Job = Job[line.arg(4).slice(-2)];
        // return [guid, name, job];
        const combatant = new Combatant(guid);
        combatant.name = name;
        combatant.job = job;
        // combatant.job = Job.ACN;
        FFXIVGenericLogHandler.activity.addCombatant(combatant);
      }
    }
  }

  private async handlePlayer(line: FFXIVLogLine) {
    console.debug('[FFXIVLogHandler] handlePlayer: ', line.arg(2));
    if (FFXIVGenericLogHandler.activity) {
      const guid = line.arg(2);
      const name = line.arg(3)
      const combatant = new Combatant(guid);
      combatant.name = name;
      FFXIVGenericLogHandler.activity.playerGUID = guid;
      FFXIVGenericLogHandler.activity.addCombatant(combatant);
    }
  }

  private async startRecording(
    // line: FFXIVLogLine,
    // category: VideoCategory,
    activity: Activity,
  ) {
    // const activity = new Battleground(line.date(), category, 5, Flavour.Retail);

    // activity.playerGUID = '12345';
    // activity.addCombatant(new Combatant('12345'));

    await FFXIVGenericLogHandler.startActivity(activity);
  }

  private async endRecording(line: FFXIVLogLine) {
    if (FFXIVGenericLogHandler.activity) {
      FFXIVGenericLogHandler.activity.end(line.date(), false);
      await FFXIVGenericLogHandler.endActivity();
    }
  }

  private parseLogLine(line: FFXIVLogLine) {
    return [
      line.arg(2),
      line.arg(3),
      line.arg(4) === 'True',
      line.arg(5) === '1',
      line.arg(6) === '1',
      line.arg(7) === '1',
      line.arg(8) === '1',
      line.arg(9) === '1',
    ];
  }

  private parseZone(zone: string): string[] {
    console.debug('[FFXIVLogHandler] Raw Zone: ', zone);
    const parts = zone.split('(');
    if (parts.length === 1) {
      return [parts[0], 'normal'];
    }
    // The Second Coil of Bahamut - Turn 1 Savage's name is the Second Coil of Bahaumt (Savage) - Turn (1)
    if (parts.length === 3) {
      if (parts[1].startsWith('Savage')) {
        return [
          `${parts[0].trim()}${parts[1].split(')')[1]}${parts[2].slice(0, -1)}`,
          'savage',
        ];
      }
    }
    // Normal Containment Bay's name is Containment Bay (S1T7)
    if (parts[0] === 'Containment Bay ') {
      return [`Containment Bay ${parts[1].slice(0, -1)}`, 'normal'];
      // The Binding Coil of Bahamut's name is the Binding Coil of Bahamut - Turn (1)
    } else if (parts[0].includes('Coil of Bahamut')) {
      return [`${parts[0]}${parts[1].slice(0, -1)}`, 'normal'];
    }
    return [parts[0].trim(), parts[1].slice(0, -1)];
  }
}
