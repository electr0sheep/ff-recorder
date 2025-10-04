import Battleground from 'activitys/Battleground';
import FFXIVGenericLogHandler from './FFXIVGenericLogHandler';
import FFXIVLogLine from './FFXIVLogLine';
import { VideoCategory } from 'types/VideoCategory';
import { FFXIVLogTypes, Flavour } from 'main/types';
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

/**
 * FFXIVLogHandler class.
 */
export default class FFXIVLogHandler extends FFXIVGenericLogHandler {
  constructor(logPath: string) {
    super(logPath, 10);

    this.combatLogWatcher.on(
      FFXIVLogTypes.ZONE_CHANGE,
      async (line: FFXIVLogLine) => {
        await this.handleZoneChange(line);
      },
    );
  }

  private async handleZoneChange(line: FFXIVLogLine) {
    const [zone, _difficulty] = this.parseZone(line.arg(3));
    console.debug('[FFXIVLogHandler] Zone: ', zone);
    if (
      trials.includes(zone) &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordTrials')
    ) {
      this.startRecording(line, VideoCategory.FFXIVTrials);
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

  private async startRecording(line: FFXIVLogLine, category: VideoCategory) {
    const activity = new Battleground(line.date(), category, 5, Flavour.Retail);

    activity.playerGUID = '12345';
    activity.addCombatant(new Combatant('12345'));

    await FFXIVGenericLogHandler.startActivity(activity);
  }

  private async endRecording(line: FFXIVLogLine) {
    if (FFXIVGenericLogHandler.activity) {
      FFXIVGenericLogHandler.activity.end(line.date(), false);
      await FFXIVGenericLogHandler.endActivity();
    }
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
      return [`${parts[0]}${parts[1].slice(0, -1)}`, 'normal']
    }
    return [parts[0].trim(), parts[1].slice(0, -1)];
  }
}
