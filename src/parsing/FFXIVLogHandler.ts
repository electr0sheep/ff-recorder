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
    if (
      trials.includes(zone) &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordTrials')
    ) {
      this.startRecording(line);
    } else if (
      raids.includes(zone) &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordRaids')
    ) {
      this.startRecording(line);
    } else if (
      dungeons.includes(zone) &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordDungeons')
    ) {
      this.startRecording(line);
    } else if (
      ars.includes(zone) &&
      ConfigService.getInstance().get<boolean>('FFXIVRecordAllianceRaids')
    ) {
      this.startRecording(line);
    } else if (ultimateRaids.includes(zone)) {
      this.startRecording(line);
    } else if (chaoticArs.includes(zone)) {
      this.startRecording(line);
    } else if (variantDungeons.includes(zone)) {
      this.startRecording(line);
    } else if (criterionDungeons.includes(zone)) {
      this.startRecording(line);
    } else {
      this.endRecording(line);
    }
  }

  private async startRecording(line: FFXIVLogLine) {
    const activity = new Battleground(
      line.date(),
      VideoCategory.Battlegrounds,
      5,
      Flavour.Retail,
    );

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
    const parts = zone.split('(');
    if (parts.length == 1) {
      return [parts[0], 'normal'];
    }
    return [parts[0].trim(), parts[1].slice(0, -1)];
  }
}
