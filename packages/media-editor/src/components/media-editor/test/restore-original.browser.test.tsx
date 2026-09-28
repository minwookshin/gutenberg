import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { screen, waitFor } from '@testing-library/react';
import { cleanup, render } from 'vitest-browser-react';
import { createRegistry, RegistryProvider } from '@wordpress/data';
import { store as coreStore } from '@wordpress/core-data';
import { store as noticesStore } from '@wordpress/notices';
// eslint-disable-next-line @wordpress/no-non-module-stylesheet-imports
import '@wordpress/components/src/style.scss';
import MediaEditor, { type MediaEditorFrameProps } from '../index';
import type { Media } from '../../media-editor-provider';
// eslint-disable-next-line @wordpress/no-non-module-stylesheet-imports
import '../../../style.scss';

const original: Media = {
	id: 10,
	source_url:
		'data:image/svg+xml,' +
		encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="black"/></svg>'
		),
	mime_type: 'image/svg+xml',
	media_details: { width: 600, height: 400 },
	alt_text: 'Original alternative text',
	title: { raw: 'Original title', rendered: 'Original title' },
	post: 5,
};
const cropped: Media = {
	...original,
	id: 11,
	source_url: `${ original.source_url }#cropped`,
	original_attachment: 10,
	alt_text: 'Cropped alternative text',
	title: { raw: 'Cropped title', rendered: 'Cropped title' },
	post: 6,
};

function Frame( { children }: MediaEditorFrameProps ) {
	return (
		<div
			style={ {
				display: 'flex',
				flexDirection: 'column',
				width: 900,
				height: 650,
			} }
		>
			<MediaEditor.HeaderActions />
			{ children }
			<MediaEditor.SaveActions />
		</div>
	);
}

async function setup() {
	await page.viewport( 1000, 800 );
	const writes = vi.fn();
	vi.spyOn( window, 'fetch' ).mockImplementation(
		async ( input, options ) => {
			const url = new URL( String( input ), window.location.href );
			const record = url.pathname.startsWith( '/wp/v2/media/10' )
				? original
				: cropped;
			if ( options?.method === 'POST' ) {
				const data = JSON.parse( String( options.body ) );
				const response = writes( url.pathname, data );
				if ( response ) {
					return response;
				}
				return Response.json( {
					...record,
					...data,
					...( url.pathname.endsWith( '/edit' ) ? { id: 12 } : {} ),
				} );
			}
			return Response.json( record );
		}
	);
	const registry = createRegistry();
	registry.register( coreStore );
	registry.register( noticesStore );
	registry.dispatch( coreStore ).addEntities( [
		{
			kind: 'postType',
			name: 'attachment',
			baseURL: '/wp/v2/media',
			baseURLParams: { context: 'edit' },
			rawAttributes: [ 'title', 'caption', 'description' ],
		},
	] );
	registry
		.dispatch( coreStore )
		.receiveEntityRecords( 'postType', 'attachment', [
			original,
			cropped,
		] );
	const onSaved = vi.fn();
	await render(
		<RegistryProvider value={ registry }>
			<MediaEditor
				id={ 11 }
				onSaved={ onSaved }
				renderFrame={ Frame }
				fields={ [
					{
						id: 'alt_text',
						label: 'Alternative text',
						type: 'text',
					},
					{
						id: 'title',
						label: 'Title',
						type: 'text',
						getValue: ( { item } ) =>
							typeof item.title === 'string'
								? item.title
								: item.title?.raw,
					},
				] }
			/>
		</RegistryProvider>
	);
	await userEvent.click( screen.getByRole( 'tab', { name: 'Details' } ) );
	return { registry, writes, onSaved };
}

async function restoreOriginal() {
	await userEvent.click(
		screen.getByRole( 'button', { name: 'More options' } )
	);
	await userEvent.click(
		screen.getByRole( 'menuitem', { name: /^Restore original image/ } )
	);
}

afterEach( async () => {
	await cleanup();
	vi.restoreAllMocks();
} );

describe( 'Restore original', () => {
	it.each( [
		{ restore: false, attachment: 'the current attachment', id: 11 },
		{ restore: true, attachment: 'the restored original', id: 10 },
	] )(
		'keeps details editable and allows retry after a failed save to $attachment',
		async ( { restore, id } ) => {
			const { writes, onSaved } = await setup();
			if ( restore ) {
				await restoreOriginal();
			}
			const alt = screen.getByRole( 'textbox', {
				name: 'Alternative text',
			} );
			await userEvent.fill( alt, 'My unsaved details' );
			writes.mockReturnValueOnce(
				Response.json(
					{
						code: 'save_failed',
						message: 'Details could not be saved.',
						data: { status: 500 },
					},
					{ status: 500 }
				)
			);

			await userEvent.click(
				screen.getByRole( 'button', { name: 'Save' } )
			);

			const notice = page.getByRole( 'button', {
				name: 'Dismiss this notice',
			} );
			await expect.element( notice ).toBeVisible();
			await expect
				.element( notice )
				.toHaveTextContent(
					'Could not save image. Details could not be saved.'
				);
			expect( onSaved ).not.toHaveBeenCalled();
			expect( alt ).toBeEnabled();
			expect( alt ).toHaveValue( 'My unsaved details' );

			await userEvent.click(
				screen.getByRole( 'button', { name: 'Save' } )
			);
			await waitFor( () =>
				expect( onSaved ).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining( { id } )
				)
			);
			expect( writes ).toHaveBeenCalledTimes( 2 );
			expect( writes ).toHaveBeenLastCalledWith(
				`/wp/v2/media/${ id }`,
				expect.objectContaining( { alt_text: 'My unsaved details' } )
			);
		}
	);

	it( 'loads editable original details and discards the cropped attachment edits', async () => {
		const { registry } = await setup();
		expect( screen.getByRole( 'textbox', { name: 'Title' } ) ).toHaveValue(
			'Cropped title'
		);
		await userEvent.fill(
			screen.getByRole( 'textbox', { name: 'Alternative text' } ),
			'Unsaved cropped text'
		);

		await restoreOriginal();

		expect( screen.getByRole( 'textbox', { name: 'Title' } ) ).toHaveValue(
			'Original title'
		);
		const alt = screen.getByRole( 'textbox', { name: 'Alternative text' } );
		expect( alt ).toBeEnabled();
		expect( alt ).toHaveValue( 'Original alternative text' );
		expect(
			registry
				.select( coreStore )
				.hasEditsForEntityRecord( 'postType', 'attachment', 11 )
		).toBe( false );
	} );

	it( 'saves an untouched restore without writing an attachment', async () => {
		const { writes, onSaved } = await setup();
		await restoreOriginal();

		await userEvent.click( screen.getByRole( 'button', { name: 'Save' } ) );

		expect( writes ).not.toHaveBeenCalled();
		expect( onSaved ).toHaveBeenCalledWith( {
			id: 10,
			url: original.source_url,
			media: original,
			previous: { id: 11, url: cropped.source_url },
		} );
	} );

	it.each( [
		{ withTransform: false, target: 'the original attachment' },
		{ withTransform: true, target: 'a new attachment after rotating' },
	] )( 'saves restored details to $target', async ( { withTransform } ) => {
		const { registry, writes, onSaved } = await setup();
		await restoreOriginal();
		await userEvent.fill(
			screen.getByRole( 'textbox', { name: 'Alternative text' } ),
			'Updated original text'
		);
		if ( withTransform ) {
			await userEvent.click(
				screen.getByRole( 'tab', { name: 'Crop' } )
			);
			await userEvent.click(
				screen.getByRole( 'button', {
					name: 'Rotate 90° clockwise',
				} )
			);
		}

		await userEvent.click( screen.getByRole( 'button', { name: 'Save' } ) );

		await waitFor( () => expect( onSaved ).toHaveBeenCalledTimes( 1 ) );
		expect( writes ).toHaveBeenCalledExactlyOnceWith(
			withTransform ? '/wp/v2/media/10/edit' : '/wp/v2/media/10',
			expect.objectContaining( { alt_text: 'Updated original text' } )
		);
		expect( onSaved ).toHaveBeenCalledWith(
			expect.objectContaining( {
				id: withTransform ? 12 : 10,
				previous: { id: 11, url: cropped.source_url },
			} )
		);
		expect(
			registry
				.select( coreStore )
				.hasEditsForEntityRecord( 'postType', 'attachment', 10 )
		).toBe( false );
		if ( withTransform ) {
			expect( writes.mock.calls[ 0 ][ 1 ] ).toMatchObject( {
				src: original.source_url,
				post: original.post,
			} );
		}
	} );
} );
