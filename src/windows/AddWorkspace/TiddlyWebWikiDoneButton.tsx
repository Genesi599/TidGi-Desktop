import { Alert, LinearProgress, Snackbar, Typography } from '@mui/material';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { ITiddlyWebWikiFormValues } from './TiddlyWebWikiForm';
import { CloseButton, ReportErrorFabButton, WikiLocation } from './FormComponents';
import { TiddlyWebCloneProgressDialog } from './TiddlyWebCloneProgressDialog';
import type { IWikiWorkspaceFormProps } from './useForm';
import { useTiddlyWebWiki, useValidateTiddlyWebWiki } from './useTiddlyWebWiki';
import { useWikiCreationProgress } from './useIndicator';

export function TiddlyWebWikiDoneButton(
  { form, errorInWhichComponentSetter, tiddlywebForm }: IWikiWorkspaceFormProps & { tiddlywebForm: ITiddlyWebWikiFormValues },
): React.JSX.Element {
  const { t } = useTranslation();
  const [hasError, wikiCreationMessage, wikiCreationMessageSetter, hasErrorSetter] = useValidateTiddlyWebWiki(
    form,
    tiddlywebForm,
    errorInWhichComponentSetter,
  );
  const { state, start, reset } = useTiddlyWebWiki(form, tiddlywebForm, wikiCreationMessageSetter, hasErrorSetter);
  const [logPanelOpened, logPanelSetter, inProgressOrError] = useWikiCreationProgress(
    wikiCreationMessageSetter,
    wikiCreationMessage,
    hasError,
  );

  // Dialog visibility: open once the pipeline starts, close only on explicit
  // user dismiss (done/error). Form-validation errors are shown inline (not
  // in the dialog) so idle state keeps the dialog hidden.
  const dialogOpen = state.stage !== 'idle';

  const handleCloseDialog = useCallback(() => {
    // If the clone succeeded, close the AddWorkspace window entirely — the
    // new workspace is already registered and active in the main window.
    // If it errored, just reset so the user can fix the form and retry.
    if (state.stage === 'done') {
      void window.remote.closeCurrentWindow();
      return;
    }
    reset();
  }, [state.stage, reset]);

  if (hasError) {
    return (
      <>
        <CloseButton variant='contained' disabled>
          {wikiCreationMessage}
        </CloseButton>
        {wikiCreationMessage !== undefined && <ReportErrorFabButton message={wikiCreationMessage} />}
      </>
    );
  }
  return (
    <>
      {inProgressOrError && <LinearProgress color='secondary' />}
      <Snackbar
        open={logPanelOpened}
        autoHideDuration={5000}
        onClose={() => {
          logPanelSetter(false);
        }}
      >
        <Alert severity='info'>{wikiCreationMessage}</Alert>
      </Snackbar>
      <CloseButton
        variant='contained'
        color='secondary'
        disabled={inProgressOrError || dialogOpen}
        onClick={() => {
          void start();
        }}
      >
        <Typography variant='body1' display='inline'>
          {t('AddWorkspace.TiddlyWebCloneWiki')}
        </Typography>
        <WikiLocation>{form.wikiFolderLocation}</WikiLocation>
      </CloseButton>
      <TiddlyWebCloneProgressDialog open={dialogOpen} state={state} onClose={handleCloseDialog} />
    </>
  );
}
