import { configSchema, ConfigurationSchema } from 'config/configSchema';
import React from 'react';
import { AppState, RecStatus } from 'main/types';
import { getLocalePhrase } from 'localisation/translations';
import { setConfigValues, useSettings } from './useSettings';
import Switch from './components/Switch/Switch';
import Label from './components/Label/Label';
import { Phrase } from 'localisation/phrases';
import { Tooltip } from './components/Tooltip/Tooltip';
import { Info } from 'lucide-react';
import { Input } from './components/Input/Input';
import Separator from './components/Separator/Separator';

interface IProps {
  recorderStatus: RecStatus;
  appState: AppState;
}

const ipc = window.electron.ipcRenderer;

const FFXIVSettings = (props: IProps) => {
  const { recorderStatus, appState } = props;
  const [config, setConfig] = useSettings();
  const initialRender = React.useRef(true);

  React.useEffect(() => {
    // Don't fire on the initial render.
    if (initialRender.current) {
      initialRender.current = false;
      return;
    }

    setConfigValues({
      recordFFXIV: config.recordFFXIV,
      FFXIVWebSocketURL: config.FFXIVWebSocketURL,
      FFXIVRecordDungeons: config.FFXIVRecordDungeons,
      FFXIVRecordTrials: config.FFXIVRecordTrials,
      FFXIVRecordRaids: config.FFXIVRecordRaids,
      FFXIVRecordAllianceRaids: config.FFXIVRecordAllianceRaids,
      FFXIVRecordDeepDungeons: config.FFXIVRecordDeepDungeons,
      FFXIVRecordVariantDungeons: config.FFXIVRecordVariantDungeons,
      FFXIVRecordCriterionDungeons: config.FFXIVRecordCriterionDungeons,
    });

    ipc.reconfigureBase();
  }, [
    config.recordFFXIV,
    config.FFXIVWebSocketURL,
    config.FFXIVRecordDungeons,
    config.FFXIVRecordTrials,
    config.FFXIVRecordRaids,
    config.FFXIVRecordAllianceRaids,
    config.FFXIVRecordDeepDungeons,
    config.FFXIVRecordVariantDungeons,
    config.FFXIVRecordCriterionDungeons,
  ]);

  const getSwitch = (
    preference: keyof ConfigurationSchema,
    changeFn: (checked: boolean) => void,
  ) => (
    <Switch
      checked={Boolean(config[preference])}
      name={preference}
      onCheckedChange={changeFn}
    />
  );

  const getSwitchForm = (
    preference: keyof ConfigurationSchema,
    label: Phrase,
    changeFn: (checked: boolean) => void,
  ) => {
    return (
      <div className="flex flex-col w-[140px]">
        <Label htmlFor={preference} className="flex items-center">
          {getLocalePhrase(appState.language, label)}
        </Label>
        <div className="flex h-10 items-center">
          {getSwitch(preference, changeFn)}
        </div>
      </div>
    );
  };

  const isComponentDisabled = () => {
    const isRecording = recorderStatus === RecStatus.Recording;
    const isOverrunning = recorderStatus === RecStatus.Overrunning;
    return isRecording || isOverrunning;
  };

  const getFFXIVSettings = () => {
    if (isComponentDisabled()) {
      return <></>;
    }

    return (
      <div className="flex flex-row gap-x-6">
        <div className="flex flex-col w-[140px]">
          <Label htmlFor="recordFFXIV" className="flex items-center">
            {getLocalePhrase(appState.language, Phrase.RecordFFXIVLabel)}
            <Tooltip
              content={getLocalePhrase(
                appState.language,
                configSchema.recordFFXIV.description,
              )}
              side="top"
            >
              <Info size={20} className="inline-flex ml-2" />
            </Tooltip>
          </Label>
          <div className="flex h-10 items-center">
            {getSwitch('recordFFXIV', setRecordFFXIV)}
          </div>
        </div>
        {config.recordFFXIV && (
          <div className="flex flex-col w-1/2">
            <Label htmlFor="FFXIVWebSocketURL" className="flex items-center">
              {getLocalePhrase(
                appState.language,
                Phrase.FFXIVWebSocketURLLabel,
              )}
              <Tooltip
                content={getLocalePhrase(
                  appState.language,
                  configSchema.FFXIVWebSocketURL.description,
                )}
                side="top"
              >
                <Info size={20} className="inline-flex ml-2" />
              </Tooltip>
            </Label>
            <Input
              value={config.FFXIVWebSocketURL}
              onChange={(e) => setFFXIVWebSocketURL(e.target.value)}
              placeholder="ws://127.0.0.1:10501/ws"
            />
          </div>
        )}
      </div>
    );
  };

  const setRecordFFXIV = (checked: boolean) => {
    setConfig((prevState) => {
      return {
        ...prevState,
        recordFFXIV: checked,
      };
    });
  };

  const setFFXIVWebSocketURL = (url: string) => {
    setConfig((prevState) => {
      return {
        ...prevState,
        FFXIVWebSocketURL: url,
      };
    });
  };

  const setRecordDungeons = (checked: boolean) => {
    setConfig((prevState) => {
      return {
        ...prevState,
        FFXIVRecordDungeons: checked,
      };
    });
  };

  const setRecordTrials = (checked: boolean) => {
    setConfig((prevState) => {
      return {
        ...prevState,
        FFXIVRecordTrials: checked,
      };
    });
  };

  const setRecordRaids = (checked: boolean) => {
    setConfig((prevState) => {
      return {
        ...prevState,
        FFXIVRecordRaids: checked,
      };
    });
  };

  const setRecordAllianceRaids = (checked: boolean) => {
    setConfig((prevState) => {
      return {
        ...prevState,
        FFXIVRecordAllianceRaids: checked,
      };
    });
  };

  const setRecordDeepDungeons = (checked: boolean) => {
    setConfig((prevState) => {
      return {
        ...prevState,
        FFXIVRecordDeepDungeons: checked,
      };
    });
  };

  const setRecordVariantDungeons = (checked: boolean) => {
    setConfig((prevState) => {
      return {
        ...prevState,
        FFXIVRecordVariantDungeons: checked,
      };
    });
  };

  const setRecordCriterionDungeons = (checked: boolean) => {
    setConfig((prevState) => {
      return {
        ...prevState,
        FFXIVRecordCriterionDungeons: checked,
      };
    });
  };

  return (
    <div className="flex flex-col gap-y-2">
      <div>{getFFXIVSettings()}</div>
      <Separator className="mt-2 mb-4" />
      <div className="flex flex-row flex-wrap gap-x-4">
        {getSwitchForm(
          'FFXIVRecordDungeons',
          Phrase.FFXIVRecordDungeons,
          setRecordDungeons,
        )}
        {getSwitchForm(
          'FFXIVRecordTrials',
          Phrase.FFXIVRecordTrials,
          setRecordTrials,
        )}
        {getSwitchForm(
          'FFXIVRecordRaids',
          Phrase.FFXIVRecordRaids,
          setRecordRaids,
        )}
        {getSwitchForm(
          'FFXIVRecordAllianceRaids',
          Phrase.FFXIVRecordAllianceRaids,
          setRecordAllianceRaids,
        )}
        {getSwitchForm(
          'FFXIVRecordDeepDungeons',
          Phrase.FFXIVRecordDeepDungeons,
          setRecordDeepDungeons,
        )}
        {getSwitchForm(
          'FFXIVRecordVariantDungeons',
          Phrase.FFXIVRecordVariantDungeons,
          setRecordVariantDungeons,
        )}
        {getSwitchForm(
          'FFXIVRecordCriterionDungeons',
          Phrase.FFXIVRecordCriterionDungeons,
          setRecordCriterionDungeons,
        )}
      </div>
    </div>
  );
};

export default FFXIVSettings;
