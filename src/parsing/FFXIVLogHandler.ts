import FFXIVGenericLogHandler from './FFXIVGenericLogHandler';
import FFXIVLogLine from './FFXIVLogLine';
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
import FFXIVRaid from 'activitys/FFXIVRaid';
import FFXIVDungeon from 'activitys/FFXIVDungeon';
import { PlayerDeathType } from 'main/types';
import FFXIVAllianceRaid from 'activitys/FFXIVAllianceRaid';

/**
 * FFXIVLogHandler class.
 */
export default class FFXIVLogHandler extends FFXIVGenericLogHandler {
  // instanceId: number | undefined;
  // instanceName: string | undefined;
  // instanceDifficulty: string | undefined;
  currentActivity: string | undefined;
  currentZone: string | undefined;
  currentZoneID: number | undefined;
  currentDifficulty: string | undefined;
  currentCombatants: Combatant[] = [];
  playerGUID: string | undefined;
  shouldRecordOnCombat: boolean = false;

  constructor(logPath: string) {
    super(logPath, 10);

    this.combatLogWatcher.on(
      LogType.PARTY_FINDER_SETTINGS,
      async (line: FFXIVLogLine) => {
        await this.handleZoneChange(line);
      },
    );
    this.combatLogWatcher.on(
      LogType.ADD_COMBATANT,
      async (line: FFXIVLogLine) => {
        await this.handlePartyMember(line);
    });
    this.combatLogWatcher.on(
      LogType.CHANGE_PRIMARY_PLAYER,
      async (line: FFXIVLogLine) => {
        await this.handlePlayer(line);
    });
    this.combatLogWatcher.on(LogType.LOG_LINE, async (line: FFXIVLogLine) => {
      await this.handleChat(line);
    });
    this.combatLogWatcher.on(LogType.DEATH, async (line: FFXIVLogLine) => {
      await this.handleDeath(line);
    });
    // this.combatLogWatcher.on(LogType.COMBATANT, async (line: FFXIVLogLine) => {
    //   await this.handleCombatant(line);
    // });
    this.combatLogWatcher.on(LogType.IN_COMBAT, async (line: FFXIVLogLine) => {
      await this.handleInCombat(line);
    });
  }

  // TODO: I don't think we need all the checking of settings here. I think
  // FFXIVGenericLogHandler does that, just try to start the activity and if
  // it's not allowed, FFXIVGenericLogHandler won't start the recording.
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
    ] = this.parseZoneChangeLogLine(line);
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
      this.currentZone = zone;
      this.currentZoneID = territoryId;
      this.currentDifficulty = difficulty;
      this.shouldRecordOnCombat = true;
      // const activity = new FFXIVTrial(line.date(), zone, difficulty);
      // activity.zoneID = territoryId;
      // FFXIVGenericLogHandler.activity = activity;
      // this.startRecording(activity);
    } else if (
      raids.includes(zone) &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordRaids')
    ) {
      const activity = new FFXIVRaid(line.date(), zone, difficulty);
      this.startRecording(activity);
    } else if (
      dungeons.includes(zone) &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordDungeons')
    ) {
      const activity = new FFXIVDungeon(line.date(), zone, difficulty);
      this.startRecording(activity);
    } else if (
      ars.includes(zone) &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordAllianceRaids')
    ) {
      const activity = new FFXIVAllianceRaid(line.date(), zone, 'Normal');
      this.startRecording(activity);
    } else if (ultimateRaids.includes(zone)) {
      const activity = new FFXIVRaid(line.date(), zone, 'Ultimate');
      this.startRecording(activity);
    } else if (chaoticArs.includes(zone)) {
      const activity = new FFXIVAllianceRaid(line.date(), zone, 'Chaotic');
      this.startRecording(activity);
    } else if (variantDungeons.includes(zone)) {
      const activity = new FFXIVDungeon(line.date(), zone, 'Variant');
      this.startRecording(activity);
    } else if (criterionDungeons.includes(zone)) {
      const activity = new FFXIVDungeon(line.date(), zone, 'Criterion');
      this.startRecording(activity);
    } else {
      this.currentZone = undefined;
      this.currentZoneID = undefined;
      this.currentDifficulty = undefined;
      this.currentCombatants = [];
      this.shouldRecordOnCombat = false;
      this.endRecording(line, false);
    }
  }

  private async handlePartyMember(line: FFXIVLogLine) {
    const guid = line.arg(2);
    const name = line.arg(3);
    const job = line.arg(4) as Job;
    const combatant = new Combatant(guid);
    combatant.name = name;
    combatant.job = job;
    this.currentCombatants.push(combatant);
    if (FFXIVGenericLogHandler.activity) {
      if (job !== Job.None) {
        console.debug('[FFXIVLogHandler] handlePartyMember: ', guid, name, job);
        // const job: Job = Job[line.arg(4).slice(-2)];
        // return [guid, name, job];
        FFXIVGenericLogHandler.activity.addCombatant(combatant);
      }
    }
  }

  private async handlePlayer(line: FFXIVLogLine) {
    const guid = line.arg(2);
    this.playerGUID = guid;
    console.debug('[FFXIVLogHandler] handlePlayer: ', line.arg(2));
    if (FFXIVGenericLogHandler.activity) {
      const name = line.arg(3);
      const combatant = new Combatant(guid);
      combatant.name = name;
      FFXIVGenericLogHandler.activity.playerGUID = guid;
      FFXIVGenericLogHandler.activity.addCombatant(combatant);
    }
  }

  private async handleChat(line: FFXIVLogLine) {
    console.debug('[FFXIVLogHandler] handleChat', line.arg(2), line.arg(4));
    if (!['0840', '0839'].includes(line.arg(2))) {
      return;
    }
    if (
      !line.arg(4).includes('completion time') &&
      !line.arg(4).includes('has ended')
    ) {
      return;
    }
    const activity = FFXIVGenericLogHandler.activity;
    if (activity) {
      this.endRecording(line, true);
    }
  }

  private async handleDeath(line: FFXIVLogLine) {
    console.debug('[FFXIVLogHandler] handleDeath', line.arg(2));
    const activity = FFXIVGenericLogHandler.activity;
    if (activity) {
      const deadPlayer = activity.getCombatant(line.arg(2));
      if (deadPlayer) {
        // deaths seem to be recorded 3 seconds after the actual death
        const deathDate = line.date().getTime() / 1000 - 3;
        const activityStartDate = activity.startDate.getTime() / 1000;
        const relativeTime = deathDate - activityStartDate;
        console.debug(
          '[FFXIVLogHandler] handleDeath',
          deathDate,
          activityStartDate,
          relativeTime,
        );
        const playerDeath: PlayerDeathType = {
          name: deadPlayer.name ? deadPlayer.name : '',
          job: deadPlayer.job,
          date: line.date(),
          timestamp: relativeTime,
          friendly: true,
        };
        activity.addDeath(playerDeath);
      }
    }
  }

  private async handleCombatant(line: FFXIVLogLine) {
    console.log('[FFXIVLogHandler] handleTargetChange');
    const activity = FFXIVGenericLogHandler.activity;
    console.log('[FFXIVLogHandler] handleTargetChange', activity);
    if (activity && activity instanceof FFXIVTrial) {
      if (line.arg(4) === 'NPCTargetID') {
        console.log('[FFXIVLogHandler] handleTargetChange startRecording');
        const activity = new FFXIVTrial(line.date(), zone, difficulty);
        activity.zoneID = territoryId;
        FFXIVGenericLogHandler.activity = activity;
        this.startRecording(activity);
      } else if (line.arg(2) === 'Remove') {
        console.log('[FFXIVLogHandler] handleTargetChange endRecording');
        this.endRecording(line, false);
      }
    }
    // if (this.instanceName && this.instanceDifficulty) {
    //   if (
    //     trials.includes(this.instanceName) &&
    //     ConfigService.getInstance().get<boolean>('FFXIVRecordTrials')
    //   ) {
    //     const activity = new FFXIVTrial(
    //       line.date(),
    //       this.instanceName,
    //       this.instanceDifficulty,
    //     );
    //     this.startRecording(activity);
    //   }
    // }
  }

  private async handleInCombat(line: FFXIVLogLine) {
    if (
      this.shouldRecordOnCombat &&
      this.currentZone &&
      this.currentDifficulty
    ) {
      switch (line.arg(3)) {
        case '0':
          this.endRecording(line, false);
          break;
        case '1':
          if (trials.includes(this.currentZone)) {
            const activity = new FFXIVTrial(
              line.date(),
              this.currentZone,
              this.currentDifficulty,
            );
            activity.playerGUID = this.playerGUID;
            this.startRecording(activity, 3);
          }
          break;
      }
    }
  }

  private async startRecording(
    // line: FFXIVLogLine,
    // category: VideoCategory,
    activity: Activity,
    offset: number = 0,
  ) {
    // const activity = new Battleground(line.date(), category, 5, Flavour.Retail);

    // activity.playerGUID = '12345';
    // activity.addCombatant(new Combatant('12345'));

    this.currentCombatants.forEach((combatant) => {
      activity.addCombatant(combatant);
    });
    await FFXIVGenericLogHandler.startActivity(activity, offset);
  }

  private async endRecording(line: FFXIVLogLine, success: boolean) {
    if (FFXIVGenericLogHandler.activity) {
      FFXIVGenericLogHandler.activity.end(line.date(), success);
      await FFXIVGenericLogHandler.endActivity();
    }
  }

  private parseZoneChangeLogLine(
    line: FFXIVLogLine,
  ): [number, string, boolean, boolean, boolean, boolean, boolean, boolean] {
    return [
      Number(`0x${line.arg(2)}`),
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
      return [parts[0], 'Normal'];
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
      return [`Containment Bay ${parts[1].slice(0, -1)}`, 'Normal'];
      // The Binding Coil of Bahamut's name is the Binding Coil of Bahamut - Turn (1)
    } else if (parts[0].includes('Coil of Bahamut')) {
      return [`${parts[0]}${parts[1].slice(0, -1)}`, 'Normal'];
    }
    return [parts[0].trim(), parts[1].slice(0, -1)];
  }
}
