import FFXIVGenericLogHandler from './FFXIVGenericLogHandler';
import FFXIVLogLine from './FFXIVLogLine';
import Combatant from 'main/Combatant';
import { zones } from 'main/FFXIVConstants';
import ConfigService from 'config/ConfigService';
import FFXIVTrial from 'activitys/FFXIVTrial';
import Activity from 'activitys/Activity';
import { LogType, Job, ContentType, Zone, Difficulty } from 'main/FFXIVTypes';
import FFXIVRaid from 'activitys/FFXIVRaid';
import FFXIVDungeon from 'activitys/FFXIVDungeon';
import { PlayerDeathType } from 'main/types';
import FFXIVAllianceRaid from 'activitys/FFXIVAllianceRaid';

/**
 * FFXIVLogHandler class.
 */
export default class FFXIVLogHandler extends FFXIVGenericLogHandler {
  currentActivity: string | undefined;
  currentZone: Zone | undefined;
  currentCombatants: Combatant[] = [];
  playerGUID: string | undefined;
  shouldRecordOnCombat: boolean = false;
  currentPull: number = 0;

  constructor(logPath: string) {
    super(logPath, 10);

    this.combatLogWatcher.on(
      LogType.CONTENT_FINDER_SETTINGS,
      async (line: FFXIVLogLine) => {
        await this.handleContentFinderSettings(line);
      },
    );
    this.combatLogWatcher.on(
      LogType.ADD_COMBATANT,
      async (line: FFXIVLogLine) => {
        await this.handleAddCombatant(line);
      },
    );
    this.combatLogWatcher.on(
      LogType.CHANGE_PRIMARY_PLAYER,
      async (line: FFXIVLogLine) => {
        await this.handlePlayer(line);
      },
    );
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
  private async handleContentFinderSettings(line: FFXIVLogLine) {
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
    const territory = zones.find((zone) => zone.id === territoryId);
    if (!territory) return;
    if (
      territory.type === ContentType.Trial &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordTrials')
    ) {
      this.currentZone = territory;
      this.shouldRecordOnCombat = true;
    } else if (
      territory.type === ContentType.Raid &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordRaids')
    ) {
      const activity = new FFXIVRaid(
        line.date(),
        territory.name,
        territory.difficulty,
      );
      this.startRecording(activity);
    } else if (
      territory.type === ContentType.Dungeon &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordDungeons')
    ) {
      const activity = new FFXIVDungeon(
        line.date(),
        territory.name,
        territory.difficulty,
      );
      this.startRecording(activity);
    } else if (
      territory.type === ContentType['Alliance Raid'] &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordAllianceRaids')
    ) {
      const activity = new FFXIVAllianceRaid(
        line.date(),
        territory.name,
        territory.difficulty,
      );
      this.startRecording(activity);
    } else if (territory.difficulty === Difficulty.Ultimate) {
      const activity = new FFXIVRaid(
        line.date(),
        territory.name,
        territory.difficulty,
      );
      this.startRecording(activity);
    } else if (territory.difficulty === Difficulty.Chaotic) {
      const activity = new FFXIVAllianceRaid(
        line.date(),
        territory.name,
        territory.difficulty,
      );
      this.startRecording(activity);
    } else if (territory.type === ContentType['Variant Dungeon']) {
      const activity = new FFXIVDungeon(
        line.date(),
        territory.name,
        territory.difficulty,
      );
      this.startRecording(activity);
    } else if (territory.type === ContentType['Criterion Dungeon']) {
      const activity = new FFXIVDungeon(
        line.date(),
        territory.name,
        territory.difficulty,
      );
      this.startRecording(activity);
    } else {
      this.currentZone = undefined;
      this.currentCombatants = [];
      this.shouldRecordOnCombat = false;
      this.currentPull = 0;
      this.endRecording(line, false);
    }
  }

  private async handleAddCombatant(line: FFXIVLogLine) {
    // Enemies are combatants who don't have a job
    const job = line.arg(4) as Job;
    if (job !== Job.None) {
      const guid = line.arg(2);
      const name = line.arg(3);
      const combatant = new Combatant(guid);
      combatant.name = name;
      combatant.job = job;
      this.currentCombatants.push(combatant);
      if (FFXIVGenericLogHandler.activity) {
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

  // private async handleCombatant(line: FFXIVLogLine) {
  //   console.log('[FFXIVLogHandler] handleTargetChange');
  //   const activity = FFXIVGenericLogHandler.activity;
  //   console.log('[FFXIVLogHandler] handleTargetChange', activity);
  //   if (activity && activity instanceof FFXIVTrial) {
  //     if (line.arg(4) === 'NPCTargetID') {
  //       console.log('[FFXIVLogHandler] handleTargetChange startRecording');
  //       const activity = new FFXIVTrial(line.date(), this.currentZone?.name, this.currentZone.difficulty);
  //       activity.zoneID = territoryId;
  //       FFXIVGenericLogHandler.activity = activity;
  //       this.startRecording(activity);
  //     } else if (line.arg(2) === 'Remove') {
  //       console.log('[FFXIVLogHandler] handleTargetChange endRecording');
  //       this.endRecording(line, false);
  //     }
  //   }
  // }

  private async handleInCombat(line: FFXIVLogLine) {
    if (this.shouldRecordOnCombat && this.currentZone) {
      switch (line.arg(3)) {
        case '0':
          this.endRecording(line, false);
          break;
        case '1':
          if (this.currentZone.type === ContentType.Trial) {
            console.debug('[FFXIVLogHandler] currentPull: ', this.currentPull);
            this.currentPull += 1;
            const activity = new FFXIVTrial(
              line.date(),
              this.currentZone.name,
              this.currentZone.difficulty,
            );
            activity.playerGUID = this.playerGUID;
            activity.pull = this.currentPull;
            this.startRecording(activity, 3);
          }
          break;
      }
    }
  }

  private async startRecording(activity: Activity, offset: number = 0) {
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

//   private parseZone(zone: string): string[] {
//     console.debug('[FFXIVLogHandler] Raw Zone: ', zone);
//     const parts = zone.split('(');
//     if (parts.length === 1) {
//       return [parts[0], 'Normal'];
//     }
//     // The Second Coil of Bahamut - Turn 1 Savage's name is the Second Coil of Bahaumt (Savage) - Turn (1)
//     if (parts.length === 3) {
//       if (parts[1].startsWith('Savage')) {
//         return [
//           `${parts[0].trim()}${parts[1].split(')')[1]}${parts[2].slice(0, -1)}`,
//           'savage',
//         ];
//       }
//     }
//     // Normal Containment Bay's name is Containment Bay (S1T7)
//     if (parts[0] === 'Containment Bay ') {
//       return [`Containment Bay ${parts[1].slice(0, -1)}`, 'Normal'];
//       // The Binding Coil of Bahamut's name is the Binding Coil of Bahamut - Turn (1)
//     } else if (parts[0].includes('Coil of Bahamut')) {
//       return [`${parts[0]}${parts[1].slice(0, -1)}`, 'Normal'];
//     }
//     return [parts[0].trim(), parts[1].slice(0, -1)];
//   }
// }
